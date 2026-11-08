import { randomUUID } from 'node:crypto';
import type { Card, ClientAction } from '@reverse-poker/shared';
import { computeLegalActions } from './betting';
import { createDeck, cryptoRng, shuffle, type Rng } from './deck';
import { compareRanks, rankBest, type HandRank } from './evaluator';
import { buildPots } from './pots';
import type {
  ActionError, ActionResult, HandResult, HandState, PlayerId, SeatState,
} from './types';

export interface PlayerInit {
  playerId: PlayerId;
  name: string;
  stack: number;
}

export interface StartHandOptions {
  players: PlayerInit[]; // seated in array order: seat 0, 1, 2, ...
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  rng?: Rng;
  deck?: Card[]; // tests only: cards are drawn from the END of this array
  handId?: string;
}

const fail = (error: ActionError): ActionResult => ({ ok: false, error });

function pay(seat: SeatState, amount: number): void {
  seat.stack -= amount;
  seat.committedThisRound += amount;
  seat.committedThisHand += amount;
  if (seat.stack === 0) seat.status = 'allIn';
}

export function startHand(opts: StartHandOptions): HandState {
  const { players, buttonSeat, smallBlind, bigBlind } = opts;
  const n = players.length;
  if (n < 2 || n > 9) throw new Error('need 2 to 9 players');
  if (!Number.isInteger(buttonSeat) || buttonSeat < 0 || buttonSeat >= n) {
    throw new Error('buttonSeat out of range');
  }
  if (!(smallBlind > 0 && bigBlind >= smallBlind)) throw new Error('bad blinds');
  for (const p of players) {
    if (!Number.isInteger(p.stack) || p.stack < 1) {
      throw new Error('every stack must be a whole number of at least 1');
    }
  }

  const seats: SeatState[] = players.map((p, i) => ({
    seat: i,
    playerId: p.playerId,
    name: p.name,
    stack: p.stack,
    committedThisRound: 0,
    committedThisHand: 0,
    status: 'active',
    hasActedThisRound: false,
    holeCards: null,
  }));

  const deck = opts.deck ? [...opts.deck] : shuffle(createDeck(), opts.rng ?? cryptoRng);

  // Heads-up, the button is the small blind. A short stack posts what it has.
  const sbSeat = n === 2 ? buttonSeat : (buttonSeat + 1) % n;
  const bbSeat = (sbSeat + 1) % n;
  pay(seats[sbSeat]!, Math.min(smallBlind, seats[sbSeat]!.stack));
  pay(seats[bbSeat]!, Math.min(bigBlind, seats[bbSeat]!.stack));

  // Deal two passes, one card at a time, starting with the small blind.
  const dealt: Card[][] = seats.map(() => []);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) dealt[(sbSeat + i) % n]!.push(deck.pop()!);
  }
  seats.forEach((s, i) => {
    s.holeCards = [dealt[i]![0]!, dealt[i]![1]!];
  });

  const state: HandState = {
    handId: opts.handId ?? randomUUID(),
    version: 0,
    phase: 'preflop',
    deck,
    board: [],
    seats,
    buttonSeat,
    smallBlind,
    bigBlind,
    toAct: null,
    currentBet: bigBlind,
    lastRaiseSize: bigBlind,
    pots: [],
    result: null,
  };
  settle(state, bbSeat); // sets toAct (or runs the hand out if nobody can act)
  return state;
}

export function applyAction(state: HandState, playerId: PlayerId, action: ClientAction): ActionResult {
  if (state.phase === 'complete') return fail('hand_over');
  const seatIdx = state.seats.findIndex((s) => s.playerId === playerId);
  if (seatIdx < 0) return fail('not_seated');
  if (state.toAct !== seatIdx) return fail('not_your_turn');

  const s = structuredClone(state); // never mutate the caller's state
  const seat = s.seats[seatIdx]!;
  const toCall = s.currentBet - seat.committedThisRound;

  switch (action.type) {
    case 'fold':
      seat.status = 'folded';
      break;
    case 'check':
      if (toCall !== 0) return fail('illegal_check');
      seat.hasActedThisRound = true;
      break;
    case 'call':
      if (toCall <= 0) return fail('illegal_call');
      pay(seat, Math.min(toCall, seat.stack)); // short stacks call all-in for less
      seat.hasActedThisRound = true;
      break;
    case 'raise': {
      const legal = computeLegalActions(s, seatIdx)!;
      const to = action.amount;
      if (!Number.isInteger(to) || !legal.canRaise || to < legal.minRaiseTo || to > legal.maxRaiseTo) {
        return fail('illegal_raise');
      }
      pay(seat, to - seat.committedThisRound);
      const size = to - s.currentBet;
      s.currentBet = to;
      if (size >= s.lastRaiseSize) {
        // A full raise reopens the betting for everyone.
        s.lastRaiseSize = size;
        for (const o of s.seats) o.hasActedThisRound = false;
      } // else: a short all-in. Players who already acted may only call or fold.
      seat.hasActedThisRound = true;
      break;
    }
  }

  s.version += 1;
  settle(s, seatIdx);
  return { ok: true, state: s };
}

/** Chips in the game. Must never change during a hand. */
export function totalChips(state: HandState): number {
  const stacks = state.seats.reduce((sum, x) => sum + x.stack, 0);
  if (state.phase === 'complete') return stacks; // pot has been paid out
  return stacks + totalCommitted(state);
}

// ---------- internals ----------

function totalCommitted(s: HandState): number {
  return s.seats.reduce((sum, x) => sum + x.committedThisHand, 0);
}

function nextActive(s: HandState, from: number): number {
  const n = s.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (s.seats[idx]!.status === 'active') return idx;
  }
  throw new Error('no active seats');
}

/** After any change: end the hand, move to the next player, or move to the next street. */
function settle(s: HandState, from: number): void {
  s.pots = buildPots(s.seats);

  const live = s.seats.filter((x) => x.status !== 'folded');
  if (live.length === 1) {
    finish(s, [{ seat: live[0]!.seat, amount: totalCommitted(s), rank: null }], false);
    return;
  }

  const able = live.filter((x) => x.status === 'active'); // not folded, not all-in
  const pending = able.filter(
    (x) => x.committedThisRound < s.currentBet || (able.length > 1 && !x.hasActedThisRound),
  );
  if (pending.length === 0) {
    nextStreet(s);
    return;
  }

  const n = s.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (pending.some((p) => p.seat === idx)) {
      s.toAct = idx;
      return;
    }
  }
}

function nextStreet(s: HandState): void {
  for (;;) {
    for (const x of s.seats) {
      x.committedThisRound = 0;
      x.hasActedThisRound = false;
    }
    s.currentBet = 0;
    s.lastRaiseSize = s.bigBlind;

    switch (s.phase) {
      case 'preflop':
        s.deck.pop(); // burn
        s.board.push(s.deck.pop()!, s.deck.pop()!, s.deck.pop()!);
        s.phase = 'flop';
        break;
      case 'flop':
        s.deck.pop();
        s.board.push(s.deck.pop()!);
        s.phase = 'turn';
        break;
      case 'turn':
        s.deck.pop();
        s.board.push(s.deck.pop()!);
        s.phase = 'river';
        break;
      case 'river':
        showdown(s);
        return;
      default:
        throw new Error(`cannot advance from phase ${s.phase}`);
    }

    // If fewer than two players can still bet, deal out the rest of the board.
    if (s.seats.filter((x) => x.status === 'active').length >= 2) {
      s.toAct = nextActive(s, s.buttonSeat); // first active seat left of the button
      return;
    }
  }
}

function showdown(s: HandState): void {
  const n = s.seats.length;
  const order = (seat: number) => (seat - s.buttonSeat - 1 + n) % n; // 0 = first left of the button

  const ranks = new Map<number, HandRank>();
  for (const x of s.seats) {
    if (x.status !== 'folded') ranks.set(x.seat, rankBest([...x.holeCards!, ...s.board]));
  }

  const payouts = new Map<number, number>();
  for (const pot of buildPots(s.seats)) {
    const contenders = pot.eligibleSeats;
    let best = ranks.get(contenders[0]!)!;
    for (const seat of contenders) {
      if (compareRanks(ranks.get(seat)!, best) > 0) best = ranks.get(seat)!;
    }
    const winners = contenders
      .filter((seat) => compareRanks(ranks.get(seat)!, best) === 0)
      .sort((a, b) => order(a) - order(b));

    // Odd chips go to the first winners left of the button.
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const w of winners) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      payouts.set(w, (payouts.get(w) ?? 0) + share + extra);
    }
  }

  const winners = [...payouts.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([seat, amount]) => ({ seat, amount, rank: ranks.get(seat)! }));
  finish(s, winners, true);
}

function finish(s: HandState, winners: HandResult['winners'], showdownHappened: boolean): void {
  for (const w of winners) s.seats[w.seat]!.stack += w.amount;
  s.result = { winners, showdown: showdownHappened };
  s.phase = 'complete';
  s.toAct = null;
  s.pots = [];
}