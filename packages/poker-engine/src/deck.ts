import { randomInt } from 'node:crypto';
import { RANKS, SUITS, type Card } from '@reverse-poker/shared';

export type Rng = (maxExclusive: number) => number;
export const cryptoRng: Rng = (n) => randomInt(n);

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

// Fisher–Yates. The RNG is injected so tests can use a seeded one.
export function shuffle(deck: readonly Card[], rng: Rng = cryptoRng): Card[] {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}