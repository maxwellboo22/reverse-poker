import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { SeatStatus } from '@reverse-poker/shared';
import { buildPots } from './pots';
import type { SeatState } from './types';

const seat = (i: number, committed: number, status: SeatStatus): SeatState => ({
  seat: i, playerId: `p${i}`, name: `P${i}`, stack: 0,
  committedThisRound: 0, committedThisHand: committed, status,
  hasActedThisRound: false, holeCards: null,
});

describe('buildPots', () => {
  it('makes one pot when nobody is all-in', () => {
    const pots = buildPots([seat(0, 100, 'active'), seat(1, 100, 'active'), seat(2, 100, 'active')]);
    expect(pots).toEqual([{ amount: 300, eligibleSeats: [0, 1, 2] }]);
  });

  it('builds a main pot and a side pot, keeping a folded player\'s chips in the main pot', () => {
    const pots = buildPots([
      seat(0, 50, 'allIn'),
      seat(1, 100, 'allIn'),
      seat(2, 100, 'active'),
      seat(3, 30, 'folded'),
    ]);
    expect(pots).toEqual([
      { amount: 180, eligibleSeats: [0, 1, 2] }, // 50 + 50 + 50 + 30
      { amount: 100, eligibleSeats: [1, 2] },
    ]);
  });

  it('puts an uncalled excess in its own pot for the player who bet it', () => {
    const pots = buildPots([seat(0, 500, 'active'), seat(1, 200, 'allIn')]);
    expect(pots).toEqual([
      { amount: 400, eligibleSeats: [0, 1] },
      { amount: 300, eligibleSeats: [0] },
    ]);
  });

  it('property: pots always add up to every chip committed', () => {
    const spec = fc.record({
      committed: fc.integer({ min: 0, max: 500 }),
      status: fc.constantFrom<SeatStatus>('active', 'allIn', 'folded'),
    });
    fc.assert(
      fc.property(fc.array(spec, { minLength: 2, maxLength: 6 }), (specs) => {
        const live = specs.filter((x) => x.status !== 'folded');
        fc.pre(live.length > 0);
        const maxLive = Math.max(...live.map((x) => x.committed));
        const seats = specs.map((x, i) => {
          const committed =
            x.status === 'folded' ? Math.min(x.committed, maxLive)
            : x.status === 'allIn' ? Math.max(1, x.committed)
            : x.committed;
          return seat(i, committed, x.status);
        });

        const pots = buildPots(seats);
        expect(pots.reduce((sum, p) => sum + p.amount, 0)).toBe(
          seats.reduce((sum, x) => sum + x.committedThisHand, 0),
        );
        for (const p of pots) {
          expect(p.eligibleSeats.length).toBeGreaterThan(0);
          for (const i of p.eligibleSeats) expect(seats[i]!.status).not.toBe('folded');
        }
      }),
    );
  });
});