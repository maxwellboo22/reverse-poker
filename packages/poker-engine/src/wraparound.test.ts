import { describe, it, expect } from 'vitest';
import { compareRanks, rankBest, rankFive, type EvalOptions } from './evaluator';
import { parseCards } from './test-utils';

const WRAP: EvalOptions = { wrapAroundStraights: true };
const five = (s: string, opts: EvalOptions = {}) => rankFive(parseCards(s), opts);
const best = (s: string, opts: EvalOptions = {}) => rankBest(parseCards(s), opts);

describe('wrap-around straights', () => {
  it.each([
    ['KS AH 2D 3C 4D', 4], // K-A-2-3-4
    ['QS KH AD 2C 3D', 3], // Q-K-A-2-3
    ['JS QH KD AC 2D', 2], // J-Q-K-A-2
  ])('%s is a straight ending on %i when wrapping is on, and high card otherwise', (cards, top) => {
    expect(five(cards, WRAP)).toEqual({ category: 4, tiebreak: [top] });
    expect(five(cards).category).toBe(0);
  });

  it('does not change ordinary straights', () => {
    for (const opts of [{}, WRAP]) {
      expect(five('AS KH QD JC TD', opts)).toEqual({ category: 4, tiebreak: [14] });
      expect(five('AS 2H 3D 4C 5D', opts)).toEqual({ category: 4, tiebreak: [5] });
      expect(five('6S 5H 4D 3C 2D', opts)).toEqual({ category: 4, tiebreak: [6] });
    }
  });

  it('ranks them below the 5-high straight, with J-Q-K-A-2 lowest', () => {
    const ladder = [
      '6S 5H 4D 3C 2D',
      'AS 2H 3D 4C 5D',
      'KS AH 2D 3C 4D',
      'QS KH AD 2C 3D',
      'JS QH KD AC 2D',
    ];
    for (let i = 0; i < ladder.length - 1; i++) {
      expect(compareRanks(five(ladder[i]!, WRAP), five(ladder[i + 1]!, WRAP))).toBeGreaterThan(0);
    }
  });

  it.each([
    'QS KH 2D 3C 4D', // missing the ace
    'KS AH 2D 3C 5D', // gap
    'JS KH AD 2C 3D', // gap
    'TS JH QD AC 2D', // missing the king
  ])('does not wrap through other ranks: %s', (cards) => {
    expect(five(cards, WRAP).category).toBe(0);
  });

  it('still beats three of a kind and loses to a flush', () => {
    expect(compareRanks(five('KS AH 2D 3C 4D', WRAP), five('7S 7H 7D KC 2D'))).toBeGreaterThan(0);
    expect(compareRanks(five('KS AH 2D 3C 4D', WRAP), five('AH JH 8H 5H 2H'))).toBeLessThan(0);
  });

  it('makes a wrap-around straight flush', () => {
    expect(five('KH AH 2H 3H 4H', WRAP)).toEqual({ category: 8, tiebreak: [4] });
    expect(five('KH AH 2H 3H 4H').category).toBe(5); // just a flush without the rule
  });

  it('finds the straight among seven cards', () => {
    expect(best('KS AH 2D 3C 4D 9C 9H', WRAP).category).toBe(4);
    expect(best('KS AH 2D 3C 4D 9C 9H').category).toBe(1); // only a pair without the rule
  });
});