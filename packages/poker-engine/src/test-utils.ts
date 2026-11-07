import { SUITS, type Card, type Rank, type Suit } from '@reverse-poker/shared';
import { createDeck, type Rng } from './deck';

const RANK_CHARS: Record<string, Rank> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/** parseCards('AS KH TD') -> three Card objects. Suits: S H D C. */
export function parseCards(text: string): Card[] {
  return text.trim().split(/\s+/).map((tok) => {
    const rank = RANK_CHARS[tok[0]!];
    const suit = tok[1] as Suit;
    if (!rank || tok.length !== 2 || !SUITS.includes(suit)) {
      throw new Error(`bad card: ${tok}`);
    }
    return { rank, suit };
  });
}

/** Small deterministic RNG for tests only. */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0;
  return (n) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return Math.floor((s / 2 ** 32) * n);
  };
}

/**
 * Build a deck that deals exactly these cards.
 * holes[i] is seat i's two cards ('AS KH'); board is five cards ('AD KD 9C 4S 3H').
 */
export function stackedDeck(opts: { buttonSeat: number; holes: string[]; board: string }): Card[] {
  const n = opts.holes.length;
  const sb = n === 2 ? opts.buttonSeat : (opts.buttonSeat + 1) % n;
  const holes = opts.holes.map(parseCards);
  const board = parseCards(opts.board);
  const key = (c: Card) => `${c.rank}${c.suit}`;
  const used = new Set([...holes.flat(), ...board].map(key));
  const unused = createDeck().filter((c) => !used.has(key(c)));
  const burns = unused.splice(0, 3);

  const draws: Card[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) draws.push(holes[(sb + i) % n]![pass]!);
  }
  draws.push(burns[0]!, board[0]!, board[1]!, board[2]!, burns[1]!, board[3]!, burns[2]!, board[4]!);
  return [...unused, ...draws.reverse()]; // pop() takes from the end
}