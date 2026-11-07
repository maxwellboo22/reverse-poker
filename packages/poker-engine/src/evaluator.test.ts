import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDeck } from './deck';
import { compareRanks, rankBest, rankFive } from './evaluator';
import { parseCards } from './test-utils';

const five = (s: string) => rankFive(parseCards(s));
const best = (s: string) => rankBest(parseCards(s));

describe('rankFive categories', () => {
  it.each([
    ['AS KS QS JS TS', 8, [14]],           // royal flush
    ['5H 4H 3H 2H AH', 8, [5]],            // steel wheel
    ['9S 9H 9D 9C KD', 7, [9, 13]],
    ['3S 3H 3D KC KD', 6, [3, 13]],
    ['AH JH 8H 5H 2H', 5, [14, 11, 8, 5, 2]],
    ['9S 8H 7D 6C 5D', 4, [9]],
    ['AS 2H 3D 4C 5D', 4, [5]],            // wheel
    ['7S 7H 7D KC 2D', 3, [7, 13, 2]],
    ['JS JH 4D 4C AD', 2, [11, 4, 14]],
    ['QS QH 9D 5C 2D', 1, [12, 9, 5, 2]],
    ['AS JH 9D 5C 3D', 0, [14, 11, 9, 5, 3]],
    ['QS KH AD 2C 3D', 0, [14, 13, 12, 3, 2]], // no wrap-around straight
  ])('%s', (cards, category, tiebreak) => {
    const r = five(cards);
    expect(r.category).toBe(category);
    expect(r.tiebreak).toEqual(tiebreak);
  });
});

describe('compareRanks', () => {
  const beats = (a: string, b: string) => {
    expect(compareRanks(five(a), five(b))).toBeGreaterThan(0);
    expect(compareRanks(five(b), five(a))).toBeLessThan(0);
  };

  it('kickers decide equal pairs', () => beats('AS AH KD 5C 2D', 'AC AD QD 5S 2H'));
  it('second pair beats a bigger kicker', () => beats('KS KH 4D 4C 2D', 'KC KD 3D 3S AH'));
  it('ace-high straight beats king-high', () => beats('AS KH QD JC TD', 'KS QH JD TC 9D'));
  it('six-high straight beats the wheel', () => beats('6S 5H 4D 3C 2D', '5S 4H 3D 2C AD'));
  it('flush beats straight', () => beats('AH JH 8H 5H 2H', '9S 8H 7D 6C 5D'));
  it('full house beats flush', () => beats('3S 3H 3D KC KD', 'AH JH 8H 5H 2H'));
  it('quads beat full house', () => beats('9S 9H 9D 9C KD', 'AS AH AD KC KD'));

  it('identical ranks tie regardless of suit', () => {
    expect(compareRanks(five('AS KH QD JC 9D'), five('AH KD QC JS 9C'))).toBe(0);
  });
});

describe('rankBest (5 to 7 cards)', () => {
  it('finds a royal flush among 7 cards', () => {
    expect(best('AS KS QS JS TS 2D 3C').category).toBe(8);
  });
  it('prefers a flush over trips in the same 7 cards', () => {
    expect(best('AH 2H 5H 9H KH KD KC').category).toBe(5);
  });
  it('turns two sets of trips into a full house', () => {
    const r = best('AS AD AC KS KD KC 2H');
    expect(r.category).toBe(6);
    expect(r.tiebreak).toEqual([14, 13]);
  });
  it('ties when the board plays', () => {
    const board = 'AS KS QS JS TS';
    expect(compareRanks(best(`${board} 2D 3C`), best(`${board} 4H 5H`))).toBe(0);
  });
});

describe('rankBest properties', () => {
  const sevenCards = fc.shuffledSubarray(createDeck(), { minLength: 7, maxLength: 7 });

  it('does not depend on card order', () => {
    fc.assert(
      fc.property(sevenCards, (cards) => {
        expect(compareRanks(rankBest(cards), rankBest([...cards].reverse()))).toBe(0);
      }),
    );
  });

  it('seven cards never rank lower than the first five', () => {
    fc.assert(
      fc.property(sevenCards, (cards) => {
        expect(compareRanks(rankBest(cards), rankBest(cards.slice(0, 5)))).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});