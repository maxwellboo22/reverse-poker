import type { Card } from '@reverse-poker/shared';

export const HAND_CATEGORIES = [
  'High card',
  'Pair',
  'Two pair',
  'Three of a kind',
  'Straight',
  'Flush',
  'Full house',
  'Four of a kind',
  'Straight flush',
] as const;

export type HandCategory = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface HandRank {
  category: HandCategory;   // index into HAND_CATEGORIES
  tiebreak: number[];       // ranks in order of importance, compared left to right
}

export interface EvalOptions {
  /**
   * Also count J-Q-K-A-2, Q-K-A-2-3 and K-A-2-3-4 as straights. They rank below
   * A-2-3-4-5, ordered by their last card, so J-Q-K-A-2 is the lowest straight.
   */
  wrapAroundStraights?: boolean;
}

// The extra straights, as ranks in descending order, with the card they end on.
const WRAP_STRAIGHTS = [
  { top: 4, ranks: [14, 13, 4, 3, 2] },
  { top: 3, ranks: [14, 13, 12, 3, 2] },
  { top: 2, ranks: [14, 13, 12, 11, 2] },
] as const;

export function describeRank(r: HandRank): string {
  return HAND_CATEGORIES[r.category];
}

/** Positive if a beats b, negative if b beats a, 0 for an exact tie. */
export function compareRanks(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const d = (a.tiebreak[i] ?? 0) - (b.tiebreak[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Rank exactly five cards. */
export function rankFive(cards: readonly Card[], opts: EvalOptions = {}): HandRank {
  if (cards.length !== 5) throw new Error('rankFive needs exactly 5 cards');

  const counts = new Map<number, number>();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);

  // Group by rank, biggest group first, then highest rank first.
  const groups = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  const shape = groups.map((g) => g.count).join('');   // e.g. '41', '32', '2111'
  const tiebreak = groups.map((g) => g.rank);
  const isFlush = cards.every((c) => c.suit === cards[0]!.suit);

  let straightHigh = 0;
  if (groups.length === 5) {
    const high = tiebreak[0]!;
    const low = tiebreak[4]!;
    if (high - low === 4) {
      straightHigh = high;
    } else if (high === 14 && tiebreak[1] === 5 && low === 2) {
      straightHigh = 5; // A-2-3-4-5
    } else if (opts.wrapAroundStraights) {
      const wrap = WRAP_STRAIGHTS.find((w) => w.ranks.every((r, i) => r === tiebreak[i]));
      if (wrap) straightHigh = wrap.top;
    }
  }

  if (straightHigh && isFlush) return { category: 8, tiebreak: [straightHigh] };
  if (shape === '41') return { category: 7, tiebreak };
  if (shape === '32') return { category: 6, tiebreak };
  if (isFlush) return { category: 5, tiebreak };
  if (straightHigh) return { category: 4, tiebreak: [straightHigh] };
  if (shape === '311') return { category: 3, tiebreak };
  if (shape === '221') return { category: 2, tiebreak };
  if (shape === '2111') return { category: 1, tiebreak };
  return { category: 0, tiebreak };
}

/** Best five-card hand from 5 to 7 cards. */
export function rankBest(cards: readonly Card[], opts: EvalOptions = {}): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error('rankBest needs 5 to 7 cards');
  }
  let best: HandRank | null = null;
  for (const combo of combinations(cards, 5)) {
    const r = rankFive(combo, opts);
    if (best === null || compareRanks(r, best) > 0) best = r;
  }
  return best!;
}

function* combinations<T>(items: readonly T[], k: number): Generator<T[]> {
  const n = items.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => items[i]!);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i] = idx[i]! + 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
}