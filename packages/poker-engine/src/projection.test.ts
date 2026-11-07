import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Card, ClientAction } from '@reverse-poker/shared';
import { applyAction, startHand } from './hand';
import { toTableView } from './projection';
import { pickAction } from './random-play';
import { seededRng, stackedDeck } from './test-utils';
import type { HandState } from './types';

const key = (c: Card) => `${c.rank}${c.suit}`;
const check: ClientAction = { type: 'check' };
const call: ClientAction = { type: 'call' };

const makePlayers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, name: `P${i}`, stack: 1000 }));

function act(state: HandState, playerId: string, action: ClientAction): HandState {
  const r = applyAction(state, playerId, action);
  if (!r.ok) throw new Error(`${playerId} ${action.type} rejected: ${r.error}`);
  return r.state;
}

function rigged(): HandState {
  const deck = stackedDeck({
    buttonSeat: 0,
    holes: ['AS AH', 'KS KH', '7D 2C'],
    board: 'AD KD 9C 4S 3H',
  });
  return startHand({ players: makePlayers(3), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
}

/** Seat 0 wins with three aces. Everyone just checks down. */
function riggedComplete(): HandState {
  let s = rigged();
  s = act(s, 'p0', call);
  s = act(s, 'p1', call);
  s = act(s, 'p2', check);
  for (let street = 0; street < 3; street++) {
    s = act(s, 'p1', check);
    s = act(s, 'p2', check);
    s = act(s, 'p0', check);
  }
  return s;
}

/** Finds every {rank, suit} object anywhere inside a value. */
function collectCards(value: unknown, out: Card[] = []): Card[] {
  if (Array.isArray(value)) {
    value.forEach((v) => collectCards(v, out));
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('rank' in o && 'suit' in o) out.push(o as unknown as Card);
    else Object.values(o).forEach((v) => collectCards(v, out));
  }
  return out;
}

/** Exactly the cards this viewer is allowed to see. */
function allowedCards(hand: HandState, viewerId: string, revealOwn: boolean): string[] {
  const keys = hand.board.map(key);
  for (const s of hand.seats) {
    if (s.holeCards && (s.playerId !== viewerId || revealOwn)) keys.push(...s.holeCards.map(key));
  }
  return keys.sort();
}

function expectNoLeaks(hand: HandState, reveal: boolean): void {
  const policy = { revealOwnCardsAfterHand: reveal };
  const revealOwn = hand.phase === 'complete' && reveal;

  for (const viewer of hand.seats) {
    const view = toTableView(hand, viewer.playerId, { policy });
    const json = JSON.stringify(view);

    // 1. The cards in the view are EXACTLY the allowed ones (board + others' hole cards).
    const seen = collectCards(JSON.parse(json)).map(key).sort();
    expect(seen).toEqual(allowedCards(hand, viewer.playerId, revealOwn));

    // 2. Belt and braces: raw text checks on the wire format.
    if (!revealOwn) {
      for (const c of viewer.holeCards!) expect(json).not.toContain(JSON.stringify(c));
    }
    for (const c of hand.deck) expect(json).not.toContain(JSON.stringify(c));
    expect(json).not.toContain('"deck"');
  }
}

describe('toTableView', () => {
  it('hides your own cards and shows everyone else\'s', () => {
    const view = toTableView(rigged(), 'p0');
    expect(view.youSeat).toBe(0);
    expect(view.seats[0]!.holeCards).toEqual({ visibility: 'hidden', count: 2 });
    expect(view.seats[1]!.holeCards).toEqual({
      visibility: 'visible',
      cards: [{ rank: 13, suit: 'S' }, { rank: 13, suit: 'H' }],
    });
    expect(view.seats[2]!.holeCards).toEqual({
      visibility: 'visible',
      cards: [{ rank: 7, suit: 'D' }, { rank: 2, suit: 'C' }],
    });
  });

  it('gives each viewer a different picture of the same hand', () => {
    const s = rigged();
    const v1 = toTableView(s, 'p1');
    expect(v1.seats[1]!.holeCards).toEqual({ visibility: 'hidden', count: 2 });
    expect(v1.seats[0]!.holeCards).toMatchObject({ visibility: 'visible' });
  });

  it('throws for a viewer who is not seated', () => {
    expect(() => toTableView(rigged(), 'stranger')).toThrow();
  });

  it('only sends legal actions to the player whose turn it is', () => {
    const s = rigged(); // seat 0 to act
    expect(toTableView(s, 'p0').legalActions).not.toBeNull();
    expect(toTableView(s, 'p1').legalActions).toBeNull();
    expect(toTableView(s, 'p2').legalActions).toBeNull();
  });

  it('only shows board cards that have been dealt', () => {
    let s = rigged();
    expect(toTableView(s, 'p1').board).toEqual([]);
    s = act(s, 'p0', call);
    s = act(s, 'p1', call);
    s = act(s, 'p2', check);
    expect(toTableView(s, 'p1').board).toHaveLength(3);
  });

  it('returns a copy: changing the view cannot change server state', () => {
    const s = rigged();
    const view = toTableView(s, 'p0');
    view.seats[0]!.stack = 0;
    const hc = view.seats[1]!.holeCards;
    if (hc?.visibility === 'visible') hc.cards[0].rank = 2;
    expect(s.seats[0]!.stack).toBe(1000);
    expect(s.seats[1]!.holeCards![0].rank).toBe(13);
  });
});

describe('reveal policy', () => {
  it('reveals your own cards when the hand completes (default)', () => {
    const s = riggedComplete();
    const v = toTableView(s, 'p0');
    expect(v.phase).toBe('complete');
    expect(v.seats[0]!.holeCards).toEqual({
      visibility: 'visible',
      cards: [{ rank: 14, suit: 'S' }, { rank: 14, suit: 'H' }],
    });
    expect(v.result!.winners).toEqual([{ seat: 0, amount: 30, handDescription: 'Three of a kind' }]);
  });

  it('keeps your own cards hidden after the hand when the policy is off', () => {
    const s = riggedComplete();
    const policy = { revealOwnCardsAfterHand: false };

    const winner = toTableView(s, 'p0', { policy });
    expect(winner.seats[0]!.holeCards).toEqual({ visibility: 'hidden', count: 2 });
    // The description would reveal the winner's own hand, so it is withheld from them...
    expect(winner.result!.winners).toEqual([{ seat: 0, amount: 30 }]);

    // ...but others already see those cards, so they may be told.
    const other = toTableView(s, 'p1', { policy });
    expect(other.result!.winners).toEqual([{ seat: 0, amount: 30, handDescription: 'Three of a kind' }]);
  });
});

describe('leak detector', () => {
  it('holds on a rigged hand at every step', () => {
    let s = rigged();
    expectNoLeaks(s, true);
    for (const [who, action] of [
      ['p0', call], ['p1', call], ['p2', check],
    ] as [string, ClientAction][]) {
      s = act(s, who, action);
      expectNoLeaks(s, true);
      expectNoLeaks(s, false);
    }
  });

  it('holds for random play, any viewer, any step, either policy', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 6 }),
        fc.boolean(),
        fc.array(fc.nat(1000), { minLength: 400, maxLength: 400 }),
        (seed, n, reveal, choices) => {
          let state = startHand({
            players: makePlayers(n), buttonSeat: seed % n, smallBlind: 5, bigBlind: 10, rng: seededRng(seed),
          });
          expectNoLeaks(state, reveal);

          let i = 0;
          while (state.phase !== 'complete' && i + 1 < choices.length) {
            const seat = state.toAct!;
            const action = pickAction(state, choices[i]!, choices[i + 1]!);
            i += 2;
            const r = applyAction(state, state.seats[seat]!.playerId, action);
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            state = r.state;
            expectNoLeaks(state, reveal);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});