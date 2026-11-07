import { randomUUID } from 'node:crypto';
import type { Card, ClientAction } from '@reverse-poker/shared';
import { computeLegalActions } from './betting';
import { createDeck, cryptoRng, shuffle, type Rng } from './deck';
import { compareRanks, rankBest } from './evaluator';
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
    if (!Number.isInteger(p.stack) || p.stack <= bigBlind) {
      throw new Error('every stack must be larger than the big blind (all-ins arrive in Milestone 2)');
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

  // Heads-up, the button is the small blind.
  const sbSeat = n === 2 ? buttonSeat : (buttonSeat + 1) % n;
  const bbSeat = (sbSeat + 1) % n;
  pay(seats[sbSeat]!, smallBlind);
  pay(seats[bbSeat]!, bigBlind);

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
    toAct: (bbSeat + 1) % n,
    currentBet: bigBlind,
    lastRaiseSize: bigBlind,
    pots: [],
    result: null,
  };
  refreshPots(state);
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
    case 'call': {
      const legal = computeLegalActions(s, seatIdx)!;
      if (!legal.canCall) return fail('illegal_call');
      pay(seat, toCall);
      seat.hasActedThisRound = true;
      break;
    }
    case 'raise': {
      const legal = computeLegalActions(s, seatIdx)!;
      const to = action.amount;
      if (!Number.isInteger(to) || !legal.canRaise || to < legal.minRaiseTo || to > legal.maxRaiseTo) {
        return fail('illegal_raise');
      }
      pay(seat, to - seat.committedThisRound);
      s.lastRaiseSize = to - s.currentBet;
      s.currentBet = to;
      for (const o of s.seats) o.hasActedThisRound = false; // everyone must respond
      seat.hasActedThisRound = true;
      break;
    }
  }

  s.version += 1;
  advance(s, seatIdx);
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

function refreshPots(s: HandState): void {
  s.pots = [{
    amount: totalCommitted(s),
    eligibleSeats: s.seats.filter((x) => x.status !== 'folded').map((x) => x.seat),
  }];
}

function nextLive(s: HandState, from: number): number {
  const n = s.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (s.seats[idx]!.status !== 'folded') return idx;
  }
  throw new Error('no live seats');
}

function advance(s: HandState, from: number): void {
  refreshPots(s);
  const live = s.seats.filter((x) => x.status !== 'folded');
  if (live.length === 1) {
    finish(s, [{ seat: live[0]!.seat, amount: totalCommitted(s), rank: null }], false);
    return;
  }
  const roundOver = live.every((x) => x.hasActedThisRound && x.committedThisRound === s.currentBet);
  if (!roundOver) {
    s.toAct = nextLive(s, from);
    return;
  }
  nextStreet(s);
}

function nextStreet(s: HandState): void {
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
  s.toAct = nextLive(s, s.buttonSeat); // first live seat left of the button
}

function showdown(s: HandState): void {
  const n = s.seats.length;
  const ranked = s.seats
    .filter((x) => x.status !== 'folded')
    .map((x) => ({ seat: x.seat, rank: rankBest([...x.holeCards!, ...s.board]) }));

  let best = ranked[0]!.rank;
  for (const r of ranked) if (compareRanks(r.rank, best) > 0) best = r.rank;

  // Winners ordered starting left of the button: they get any odd chips first.
  const winners = ranked
    .filter((r) => compareRanks(r.rank, best) === 0)
    .sort((a, b) => ((a.seat - s.buttonSeat - 1 + n) % n) - ((b.seat - s.buttonSeat - 1 + n) % n));

  const pot = totalCommitted(s);
  const share = Math.floor(pot / winners.length);
  let remainder = pot - share * winners.length;
  const payouts = winners.map((w) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { seat: w.seat, amount: share + extra, rank: w.rank };
  });
  finish(s, payouts, true);
}

function finish(s: HandState, winners: HandResult['winners'], showdownHappened: boolean): void {
  for (const w of winners) s.seats[w.seat]!.stack += w.amount;
  s.result = { winners, showdown: showdownHappened };
  s.phase = 'complete';
  s.toAct = null;
  s.pots = [];
}