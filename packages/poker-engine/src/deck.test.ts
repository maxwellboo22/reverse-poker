import { describe, it, expect } from 'vitest';
import { createDeck, shuffle, type Rng } from './deck';

const seeded = (seed: number): Rng => (n) => {
  seed = (seed * 1664525 + 1013904223) >>> 0; // simple LCG, for tests only
  return seed % n;
};
const key = (c: { rank: number; suit: string }) => `${c.rank}${c.suit}`;

describe('deck', () => {
  it('has 52 unique cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(key)).size).toBe(52);
  });
  it('shuffle keeps the same cards', () => {
    const shuffled = shuffle(createDeck(), seeded(1));
    expect(shuffled.map(key).sort()).toEqual(createDeck().map(key).sort());
  });
  it('is deterministic with a seeded RNG', () => {
    expect(shuffle(createDeck(), seeded(42))).toEqual(shuffle(createDeck(), seeded(42)));
  });
});