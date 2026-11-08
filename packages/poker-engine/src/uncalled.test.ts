import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { ClientAction } from '@reverse-poker/shared';
import { applyAction, startHand, totalChips } from './hand';
import { pickAction } from './random-play';
import { seededRng, stackedDeck } from './test-utils';
import type { HandState } from './types';

const players = (stacks: number[]) =>
  stacks.map((stack, i) => ({ playerId: `p${i}`, name: `P${i}`, stack }));
const raiseTo = (amount: number): ClientAction => ({ type: 'raise', amount });
const call: ClientAction = { type: 'call' };

function act(state: HandState, playerId: string, action: ClientAction): HandState {
  const r = applyAction(state, playerId, action);
  if (!r.ok) throw new Error(`${playerId} ${action.type} rejected: ${r.error}`);
  return r.state;
}

describe('all-in showdowns report who actually won', () => {
  it('unequal stacks: only the real winner "wins"; the excess is a refund', () => {
    const deck = stackedDeck({
      buttonSeat: 0,
      holes: ['KS KH', 'AS AH'],
      board: '9C 8D 3S 4H JD',
    });
    let s = startHand({ players: players([1500, 500]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    s = act(s, 'p0', raiseTo(1500));
    s = act(s, 'p1', call);

    expect(s.phase).toBe('complete');
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[1, 1000]]);
    expect(s.result!.refunds).toEqual([{ seat: 0, amount: 1000 }]);
    expect(s.seats.map((x) => x.stack)).toEqual([1000, 1000]);
    expect(totalChips(s)).toBe(2000);
  });

  it('equal stacks: one winner takes everything, no refund', () => {
    const deck = stackedDeck({
      buttonSeat: 0,
      holes: ['AS AH', 'KS KH'],
      board: '9C 8D 3S 4H JD',
    });
    let s = startHand({ players: players([1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    s = act(s, 'p0', raiseTo(1000));
    s = act(s, 'p1', call);

    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[0, 2000]]);
    expect(s.result!.refunds).toEqual([]);
    expect(s.seats.map((x) => x.stack)).toEqual([2000, 0]);
  });

  it('a genuine tie splits the pot, with no refund', () => {
    const deck = stackedDeck({
      buttonSeat: 0,
      holes: ['2D 3C', '4D 5C'],
      board: 'AS KS QS JS TS',
    });
    let s = startHand({ players: players([1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    s = act(s, 'p0', raiseTo(1000));
    s = act(s, 'p1', call);

    expect(s.result!.winners.map((w) => w.amount)).toEqual([1000, 1000]);
    expect(s.result!.refunds).toEqual([]);
    expect(s.seats.map((x) => x.stack)).toEqual([1000, 1000]);
  });

  it('property: winnings + refunds always equal everything that was put in', () => {
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
          let i = 0;
          while (state.phase !== 'complete') {
            if (i + 1 >= choices.length) return;
            const seat = state.toAct!;
            const r = applyAction(state, state.seats[seat]!.playerId, pickAction(state, choices[i]!, choices[i + 1]!));
            i += 2;
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            state = r.state;
          }
          const result = state.result!;
          const paid =
            result.winners.reduce((sum, w) => sum + w.amount, 0) +
            result.refunds.reduce((sum, r) => sum + r.amount, 0);
          expect(paid).toBe(state.seats.reduce((sum, x) => sum + x.committedThisHand, 0));
          expect(result.refunds.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});