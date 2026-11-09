import { describe, it, expect } from 'vitest';
import { RANKS, SUITS, type Card, type Rank, type Suit } from '@reverse-poker/shared';
import { rankBest, type HandRank } from '@reverse-poker/poker-engine';
import {
  describeRule, evaluateRules, handMatches, type HandPattern, type PlayerChips, type Rule, type WinnerInfo,
} from './game/rules';

const RANK_CHARS: Record<string, Rank> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function cards(text: string): Card[] {
  return text.trim().split(/\s+/).map((t) => ({ rank: RANK_CHARS[t[0]!]!, suit: t[1] as Suit }));
}

function winner(id: string, hole: string, rank: HandRank | null = null): WinnerInfo {
  const [a, b] = cards(hole);
  return { playerId: id, holeCards: [a!, b!], rank };
}

const hole = (high: number, low: number, suited: 'suited' | 'offsuit' | 'any'): HandPattern => ({
  kind: 'hole', high: high as Rank, low: low as Rank, suited,
});

const sevenDeuce: Rule = {
  who: { kind: 'anyone' },
  hand: hole(7, 2, 'offsuit'),
  effect: { from: { kind: 'everyone' }, to: { kind: 'winner' }, amount: 10 },
};

const players = (chips: number[]): PlayerChips[] =>
  chips.map((c, i) => ({ id: 'abcdef'[i]!, name: ['Alice', 'Bob', 'Cara', 'Dan', 'Eve', 'Fay'][i]!, chips: c }));

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('handMatches', () => {
  it('matches offsuit and suited holdings regardless of card order', () => {
    expect(handMatches(hole(7, 2, 'offsuit'), winner('a', '7S 2D'))).toBe(true);
    expect(handMatches(hole(7, 2, 'offsuit'), winner('a', '2D 7S'))).toBe(true);
    expect(handMatches(hole(7, 2, 'offsuit'), winner('a', '7S 2S'))).toBe(false);
    expect(handMatches(hole(7, 2, 'suited'), winner('a', '7S 2S'))).toBe(true);
    expect(handMatches(hole(7, 2, 'any'), winner('a', '7S 2S'))).toBe(true);
    expect(handMatches(hole(7, 2, 'any'), winner('a', '7S 3S'))).toBe(false);
  });

  it('treats equal ranks as a pocket pair', () => {
    expect(handMatches(hole(14, 14, 'any'), winner('a', 'AS AH'))).toBe(true);
    expect(handMatches(hole(14, 14, 'any'), winner('a', 'KS KH'))).toBe(false);
    expect(handMatches({ kind: 'pocketPair' }, winner('a', '3S 3H'))).toBe(true);
    expect(handMatches({ kind: 'pocketPair' }, winner('a', '3S 4H'))).toBe(false);
  });

  it('matches hand categories only when there is a showdown rank', () => {
    const flush: HandPattern = { kind: 'category', category: 5, royal: false };
    const rank = rankBest(cards('AH JH 8H 5H 2H KC 3D'));
    expect(handMatches(flush, winner('a', 'AH JH', rank))).toBe(true);
    expect(handMatches(flush, winner('a', 'AH JH', null))).toBe(false);
    expect(handMatches({ kind: 'category', category: 6, royal: false }, winner('a', 'AH JH', rank))).toBe(false);
  });

  it('tells a royal flush from other straight flushes', () => {
    const royal: HandPattern = { kind: 'category', category: 8, royal: true };
    const straightFlush: HandPattern = { kind: 'category', category: 8, royal: false };
    const royalRank = rankBest(cards('AS KS QS JS TS 2D 3C'));
    const nineHigh = rankBest(cards('9S 8S 7S 6S 5S 2D 3C'));
    expect(handMatches(royal, winner('a', 'AS KS', royalRank))).toBe(true);
    expect(handMatches(royal, winner('a', '9S 8S', nineHigh))).toBe(false);
    expect(handMatches(straightFlush, winner('a', '9S 8S', nineHigh))).toBe(true);
  });
});

describe('evaluateRules', () => {
  it('everyone pays the winner', () => {
    const out = evaluateRules([sevenDeuce], [winner('a', '7S 2D')], players([100, 100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 120], ['b', 90], ['c', 90]]);
    expect(out.changed).toBe(true);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('Rule 1 triggered: Alice won with 7-2 offsuit.');
    expect(out.lines[0]).toContain('Bob pays Alice 10');
    expect(out.lines[0]).toContain('Cara pays Alice 10');
  });

  it('does nothing when the winning hand does not match', () => {
    const out = evaluateRules([sevenDeuce], [winner('a', 'AS KS')], players([100, 100, 100]));
    expect(out.changed).toBe(false);
    expect(out.lines).toEqual([]);
    expect([...out.chips.values()]).toEqual([100, 100, 100]);
  });

  it('players pay what they have, and the announcement says so', () => {
    const out = evaluateRules([sevenDeuce], [winner('a', '7S 2D')], players([100, 4, 100]));
    expect(out.chips.get('b')).toBe(0);
    expect(out.chips.get('a')).toBe(114);
    expect(out.lines[0]).toContain("couldn't pay in full");
  });

  it('says so when nobody can pay', () => {
    const out = evaluateRules([sevenDeuce], [winner('a', '7S 2D')], players([100, 0, 0]));
    expect(out.changed).toBe(false);
    expect(out.lines[0]).toContain('Nobody had chips to pay');
  });

  it('a specific payer and receiver, only when the named player wins', () => {
    const rule: Rule = {
      who: { kind: 'player', playerId: 'd' },
      hand: null,
      effect: { from: { kind: 'player', playerId: 'b' }, to: { kind: 'player', playerId: 'c' }, amount: 10 },
    };
    const when = evaluateRules([rule], [winner('d', '2C 3D')], players([100, 100, 100, 100]));
    expect(when.chips.get('b')).toBe(90);
    expect(when.chips.get('c')).toBe(110);
    const otherwise = evaluateRules([rule], [winner('a', '2C 3D')], players([100, 100, 100, 100]));
    expect(otherwise.changed).toBe(false);
  });

  it('the winner pays everyone else', () => {
    const rule: Rule = {
      who: { kind: 'anyone' },
      hand: null,
      effect: { from: { kind: 'winner' }, to: { kind: 'everyone' }, amount: 5 },
    };
    const out = evaluateRules([rule], [winner('a', '2C 3D')], players([100, 100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 90], ['b', 105], ['c', 105]]);
  });

  it('skips rules that name a player who has left', () => {
    const rule: Rule = {
      who: { kind: 'anyone' },
      hand: null,
      effect: { from: { kind: 'player', playerId: 'ghost' }, to: { kind: 'winner' }, amount: 10 },
    };
    const out = evaluateRules([rule], [winner('a', '2C 3D')], players([100, 100]));
    expect(out.changed).toBe(false);
    expect(out.lines).toEqual([]);
  });

  it('with split winners, each winner triggers the rule and chips are conserved', () => {
    const rule: Rule = { ...sevenDeuce, hand: null };
    const before = players([100, 100, 100]);
    const out = evaluateRules([rule], [winner('a', '2C 3D'), winner('b', '4C 5D')], before);
    expect(out.lines).toHaveLength(2);
    expect(total(out.chips)).toBe(300);
  });

  it('applies rules in order and numbers them', () => {
    const second: Rule = { ...sevenDeuce, hand: null, effect: { ...sevenDeuce.effect, amount: 1 } };
    const out = evaluateRules([sevenDeuce, second], [winner('a', '7S 2D')], players([100, 100]));
    expect(out.lines[0]).toContain('Rule 1');
    expect(out.lines[1]).toContain('Rule 2');
    expect(out.chips.get('a')).toBe(111);
  });
});

describe('describeRule', () => {
  const names = (id: string) => ({ a: 'Alice', b: 'Bob', c: 'Cara' } as Record<string, string>)[id] ?? null;

  it('writes rules in plain words', () => {
    expect(describeRule(sevenDeuce, names)).toEqual({
      text: 'If someone wins with 7-2 offsuit: everyone else pays the winner 10 chips each.',
      active: true,
    });
    expect(
      describeRule(
        {
          who: { kind: 'player', playerId: 'c' },
          hand: { kind: 'category', category: 5, royal: false },
          effect: { from: { kind: 'player', playerId: 'a' }, to: { kind: 'player', playerId: 'b' }, amount: 1000 },
        },
        names,
      ).text,
    ).toBe('If Cara wins with a flush: Alice pays Bob 1,000 chips.');
    expect(
      describeRule({ ...sevenDeuce, hand: hole(14, 14, 'any') }, names).text,
    ).toContain('pocket aces');
  });

  it('marks a rule inactive when a player in it has left', () => {
    const rule: Rule = { ...sevenDeuce, who: { kind: 'player', playerId: 'ghost' } };
    const d = describeRule(rule, names);
    expect(d.active).toBe(false);
    expect(d.text).toContain('a player who left');
  });
});

describe('sanity', () => {
  it('has a full deck to test with', () => {
    expect(SUITS.flatMap((s) => RANKS.map((r) => ({ r, s })))).toHaveLength(52);
  });
});