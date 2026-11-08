import type { Pot, SeatState } from './types';

const sameSeats = (a: number[], b: number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Builds the main pot and side pots from what each seat has put in this hand.
 * A new layer starts at every all-in amount. Folded players' chips stay in
 * the pot, but they can't win it. Players who can still act are eligible for
 * every layer, since they must match before showdown.
 */
export function buildPots(seats: readonly SeatState[]): Pot[] {
  const levels = [
    ...new Set(seats.filter((s) => s.status === 'allIn').map((s) => s.committedThisHand)),
  ].sort((a, b) => a - b);
  levels.push(Infinity);

  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const s of seats) amount += Math.max(0, Math.min(s.committedThisHand, level) - prev);

    if (amount > 0) {
      const eligible = seats
        .filter((s) => s.status !== 'folded' && (s.status === 'active' || s.committedThisHand > prev))
        .map((s) => s.seat);
      const last = pots[pots.length - 1];
      if (last && (eligible.length === 0 || sameSeats(last.eligibleSeats, eligible))) {
        last.amount += amount;
      } else {
        pots.push({ amount, eligibleSeats: eligible });
      }
    }
    prev = level;
  }
  return pots;
}