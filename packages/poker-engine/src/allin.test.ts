import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Card, ClientAction } from '@reverse-poker/shared';
import { computeLegalActions } from './betting';
import { applyAction, startHand, totalChips } from './hand';
import { pickAction } from './random-play';
import { seededRng, stackedDeck } from './test-utils';
import type { HandState } from './types';

const players = (stacks: number[]) =>
  stacks.map((stack, i) => ({ playerId: `p${i}`, name: `P${i}`, stack }));
const raiseTo = (amount: number): ClientAction => ({ type: 'raise', amount });
const call: ClientAction = { type: 'call' };
const key = (c: Card) => `${c.rank}${c.suit}`;

function act(state: HandState, playerId: string, action: ClientAction): HandState {
  const r = applyAction(state, playerId, action);
  if (!r.ok) throw new Error(`${playerId} ${action.type} rejected: ${r.error}`);
  return r.state;
}

describe('all-ins and side pots', () => {
  it('pays the main pot and the side pot to different winners', () => {
    const deck = stackedDeck({
      buttonSeat: 0,
      holes: ['AS AH', 'KS KH', '7D 2C'],
      board: '9C 8D 3S 4H JD',
    });
    let s = startHand({ players: players([100, 300, 500]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });

    s = act(s, 'p0', raiseTo(100)); // all-in
    s = act(s, 'p1', raiseTo(300)); // all-in
    expect(s.seats.map((x) => x.status)).toEqual(['allIn', 'allIn', 'active']);

    // p2 can only call or fold: nobody is left to raise against.
    const legal = computeLegalActions(s, 2)!;
    expect(legal.canCall).toBe(true);
    expect(legal.callAmount).toBe(290);
    expect(legal.canRaise).toBe(false);

    s = act(s, 'p2', call);
    expect(s.phase).toBe('complete'); // the board runs out automatically
    expect(s.board).toHaveLength(5);

    // Main pot 300 -> seat 0 (aces). Side pot 400 -> seat 1 (kings beat seven-high).
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[1, 400], [0, 300]]);
    expect(s.seats.map((x) => x.stack)).toEqual([300, 400, 200]);
    expect(totalChips(s)).toBe(900);
  });

  it('lets a short stack call all-in for less, and returns the uncalled excess', () => {
    const deck = stackedDeck({
      buttonSeat: 0,
      holes: ['2D 3C', 'AS AH'],
      board: '9C 8D 5S KH JD',
    });
    let s = startHand({ players: players([1000, 60]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });

    s = act(s, 'p0', raiseTo(200));
    expect(computeLegalActions(s, 1)!.callAmount).toBe(50); // all it has left
    s = act(s, 'p1', call);

    expect(s.phase).toBe('complete');
    // Contested: 60 + 60 = 120 -> seat 1. Seat 0 gets its extra 140 back.
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[1, 120], [0, 140]]);
    expect(s.seats.map((x) => x.stack)).toEqual([940, 120]);
    expect(totalChips(s)).toBe(1060);
  });

  it('runs the hand out immediately when a blind puts a player all-in', () => {
    const deck = stackedDeck({
      buttonSeat: 0,
      holes: ['AS AH', '7C 2D'],
      board: 'KC 9D 5S 4H JD',
    });
    const s = startHand({ players: players([3, 100]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });

    expect(s.phase).toBe('complete');
    expect(s.board).toHaveLength(5);
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[1, 7], [0, 6]]);
    expect(s.seats.map((x) => x.stack)).toEqual([6, 97]);
    expect(totalChips(s)).toBe(103);
  });
});

describe('reopening the betting', () => {
  it('a short all-in does not let players who already acted raise again', () => {
    let s = startHand({
      players: players([1000, 1000, 130]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, rng: seededRng(5),
    });
    s = act(s, 'p0', raiseTo(100)); // full raise, last raise size 90
    s = act(s, 'p1', call);
    s = act(s, 'p2', raiseTo(130)); // all-in, only 30 more: a short raise

    expect(s.currentBet).toBe(130);
    expect(s.lastRaiseSize).toBe(90); // unchanged
    expect(s.toAct).toBe(0);
    expect(computeLegalActions(s, 0)).toMatchObject({
      canRaise: false, canCall: true, callAmount: 30, canCheck: false,
    });
    expect(applyAction(s, 'p0', raiseTo(500))).toEqual({ ok: false, error: 'illegal_raise' });

    s = act(s, 'p0', call);
    s = act(s, 'p1', call);
    expect(s.phase).toBe('flop');
  });

  it('a full raise does reopen it', () => {
    let s = startHand({
      players: players([1000, 1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, rng: seededRng(5),
    });
    s = act(s, 'p0', raiseTo(100));
    s = act(s, 'p1', call);
    s = act(s, 'p2', raiseTo(300)); // raise of 200, bigger than 90: a full raise

    const legal = computeLegalActions(s, 0)!;
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(500);
  });
});

describe('random play with random stacks', () => {
  it('conserves chips, never gets stuck, and accepts every legal move', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.array(fc.integer({ min: 1, max: 300 }), { minLength: 2, maxLength: 6 }),
        fc.array(fc.nat(1000), { minLength: 600, maxLength: 600 }),
        (seed, stacks, choices) => {
          const n = stacks.length;
          let state = startHand({
            players: players(stacks), buttonSeat: seed % n, smallBlind: 5, bigBlind: 10, rng: seededRng(seed),
          });
          const total = stacks.reduce((a, b) => a + b, 0);
          expect(totalChips(state)).toBe(total);

          let i = 0;
          while (state.phase !== 'complete') {
            expect(state.toAct).not.toBeNull(); // a live hand always has someone to act
            if (i + 1 >= choices.length) return;
            const seat = state.toAct!;
            const action = pickAction(state, choices[i]!, choices[i + 1]!);
            i += 2;

            const r = applyAction(state, state.seats[seat]!.playerId, action);
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            state = r.state;

            expect(totalChips(state)).toBe(total);
            for (const x of state.seats) expect(x.stack).toBeGreaterThanOrEqual(0);
            const cards = [...state.deck, ...state.board, ...state.seats.flatMap((x) => x.holeCards!)];
            expect(new Set(cards.map(key)).size).toBe(cards.length);
            if (state.phase !== 'complete') {
              expect(state.pots.reduce((sum, p) => sum + p.amount, 0)).toBe(
                state.seats.reduce((sum, x) => sum + x.committedThisHand, 0),
              );
            }
          }
          expect(state.result).not.toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});