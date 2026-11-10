import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Card, Suit } from '@reverse-poker/shared';
import { rankBest, type HandRank } from '@reverse-poker/poker-engine';
import {
  MAX_PLAYER_CHIPS, cardMatches, condMatches, describeRule, evaluateRules, ruleReferencedIds, triggerHits,
  type Amount, type Condition, type Effect, type HandSummary, type Party, type PlayerChips, type Rule,
  type SeatOutcome, type Trigger, type TriggerWho,
} from './game/rules';

// ---------- helpers ----------

const RANK_CHARS: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function cards(text: string): Card[] {
  return text.trim().split(/\s+/).map((t) => ({
    rank: RANK_CHARS[t[0]!]!,
    suit: t[1] as Suit,
  })) as Card[];
}

const NAMES = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve', 'Fay'];
const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

const players = (chips: number[]): PlayerChips[] =>
  chips.map((c, i) => ({ id: IDS[i]!, name: NAMES[i]!, chips: c }));

function seat(id: string, hole: string, o: Partial<SeatOutcome> = {}): SeatOutcome {
  const [a, b] = cards(hole);
  return { playerId: id, holeCards: [a!, b!], won: 0, folded: false, allIn: false, rank: null, bet: 0, ...o };
}

const summary = (seats: SeatOutcome[], o: Partial<HandSummary> = {}): HandSummary => ({
  seats, board: [], showdown: true, pot: 0, ...o,
});

const ANYONE: TriggerWho = { kind: 'anyone' };
const everyone: Party = { kind: 'everyone' };
const others: Party = { kind: 'others' };
const subject: Party = { kind: 'subject' };
const only = (...ids: string[]): Party => ({ kind: 'players', playerIds: ids });
const fixed = (n: number): Amount => ({ kind: 'fixed', n });

const make = (trigger: Trigger, effects: Effect[], o: Partial<Rule> = {}): Rule => ({
  trigger, who: ANYONE, cond: null, effects, ...o,
});

const gain = (n: number): Effect => ({ kind: 'gain', to: subject, amount: fixed(n) });
const hole72: Condition = { kind: 'hole', high: 7, low: 2, suited: 'offsuit' };
const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

interface Extra {
  rank?: HandRank | null;
  board?: string;
  showdown?: boolean;
  pot?: number;
  chips?: number;
  bet?: number;
  others?: number;
}

/** Does this condition match a player holding `hole`? */
function check(cond: Condition, hole: string, x: Extra = {}): boolean {
  const me = seat('a', hole, { rank: x.rank ?? null, bet: x.bet ?? 0 });
  const filler = Array.from({ length: x.others ?? 0 }, (_, i) => seat(IDS[i + 1]!, '2C 3D'));
  const sum = summary([me, ...filler], {
    board: x.board ? cards(x.board) : [],
    showdown: x.showdown ?? true,
    pot: x.pot ?? 0,
  });
  return condMatches(cond, { seat: me, summary: sum, chips: x.chips ?? 0 });
}

// ---------- matching ----------

describe('cardMatches', () => {
  const c = (t: string) => cards(t)[0]!;

  it('matches by rank, suit, colour and rank range', () => {
    expect(cardMatches({ rank: 14, suit: 'S' }, c('AS'))).toBe(true);
    expect(cardMatches({ rank: 14, suit: 'S' }, c('AH'))).toBe(false);
    expect(cardMatches({ suit: 'H' }, c('2H'))).toBe(true);
    expect(cardMatches({ color: 'red' }, c('2D'))).toBe(true);
    expect(cardMatches({ color: 'red' }, c('2C'))).toBe(false);
    expect(cardMatches({ color: 'black' }, c('AS'))).toBe(true);
    expect(cardMatches({ minRank: 10, maxRank: 13 }, c('KS'))).toBe(true);
    expect(cardMatches({ minRank: 10, maxRank: 13 }, c('AS'))).toBe(false);
    expect(cardMatches({}, c('7C'))).toBe(true);
  });
});

describe('condMatches: hole cards', () => {
  it('suited and offsuit holdings, in any order', () => {
    expect(check(hole72, '7S 2D')).toBe(true);
    expect(check(hole72, '2D 7S')).toBe(true);
    expect(check(hole72, '7S 2S')).toBe(false);
    expect(check({ kind: 'hole', high: 7, low: 2, suited: 'suited' }, '7S 2S')).toBe(true);
    expect(check({ kind: 'hole', high: 7, low: 2, suited: 'any' }, '7S 2S')).toBe(true);
    expect(check({ kind: 'hole', high: 7, low: 2, suited: 'any' }, '7S 3S')).toBe(false);
  });

  it('pocket pairs', () => {
    expect(check({ kind: 'hole', high: 14, low: 14, suited: 'any' }, 'AS AH')).toBe(true);
    expect(check({ kind: 'hole', high: 14, low: 14, suited: 'any' }, 'KS KH')).toBe(false);
    expect(check({ kind: 'pocketPair' }, '3S 3H')).toBe(true);
    expect(check({ kind: 'pocketPair' }, '3S 4H')).toBe(false);
  });

  it('specific cards', () => {
    expect(check({ kind: 'cards', match: { rank: 14, suit: 'S' }, count: 1 }, 'AS KH')).toBe(true);
    expect(check({ kind: 'cards', match: { rank: 14, suit: 'S' }, count: 1 }, 'KH QH')).toBe(false);
    expect(check({ kind: 'cards', match: { rank: 14 }, count: 1 }, 'AH 2C')).toBe(true);
  });

  it('counts of matching cards', () => {
    const twoHearts: Condition = { kind: 'cards', match: { suit: 'H' }, count: 2 };
    expect(check(twoHearts, '7H 2H')).toBe(true);
    expect(check(twoHearts, '7H 2D')).toBe(false);
  });

  it('colours and rank groups', () => {
    const red: Condition = { kind: 'cards', match: { color: 'red' }, count: 1 };
    expect(check(red, '7S 2D')).toBe(true);
    expect(check(red, '7S 2C')).toBe(false);
    const face: Condition = { kind: 'cards', match: { minRank: 11, maxRank: 13 }, count: 1 };
    expect(check(face, 'AS KS')).toBe(true);
    expect(check(face, 'AS 2S')).toBe(false);
    const tenUp: Condition = { kind: 'cards', match: { minRank: 10 }, count: 1 };
    expect(check(tenUp, 'AS 2S')).toBe(true);
    expect(check(tenUp, '9S 2S')).toBe(false);
  });

  it('suited, offsuit and connected shapes', () => {
    const suited: Condition = { kind: 'shape', suited: true, connected: false };
    expect(check(suited, '7S 2S')).toBe(true);
    expect(check(suited, '7S 2D')).toBe(false);
    const offsuit: Condition = { kind: 'shape', suited: false, connected: false };
    expect(check(offsuit, '7S 2D')).toBe(true);
    expect(check(offsuit, '7S 2S')).toBe(false);

    const connectors: Condition = { kind: 'shape', suited: null, connected: true };
    expect(check(connectors, '7S 8D')).toBe(true);
    expect(check(connectors, '7S 9D')).toBe(false);
    expect(check(connectors, 'AS 2D')).toBe(true); // the ace connects with a two
    expect(check(connectors, 'AS KD')).toBe(true);

    const suitedConnectors: Condition = { kind: 'shape', suited: true, connected: true };
    expect(check(suitedConnectors, '7S 8S')).toBe(true);
    expect(check(suitedConnectors, '7S 8D')).toBe(false);
  });
});

describe('condMatches: the board, hand names and the hand itself', () => {
  it('looks at the board', () => {
    const aceOnBoard: Condition = { kind: 'board', match: { rank: 14 }, count: 1 };
    expect(check(aceOnBoard, '2S 3S', { board: 'AH 7C 8D' })).toBe(true);
    expect(check(aceOnBoard, '2S 3S', { board: 'KH 7C 8D' })).toBe(false);
  });

  it('hand names need a showdown rank', () => {
    const flushRank = rankBest(cards('AH JH 8H 5H 2H KC 3D'));
    const flush: Condition = { kind: 'category', category: 5, royal: false, orBetter: false, rank: null };
    const better: Condition = { ...flush, category: 6 } as Condition;
    const straightOrBetter: Condition = { ...flush, category: 4, orBetter: true } as Condition;

    expect(check(flush, 'AH JH', { rank: flushRank })).toBe(true);
    expect(check(flush, 'AH JH', { rank: null })).toBe(false);
    expect(check(better, 'AH JH', { rank: flushRank })).toBe(false);
    expect(check(straightOrBetter, 'AH JH', { rank: flushRank })).toBe(true);
  });

  it('pairs and high cards of a given rank', () => {
    const pairOfAces = rankBest(cards('AS AD 7C 4H 2D 9S 3C'));
    const aceHigh = rankBest(cards('AS KD 9H 7C 4D 3S 2C'));
    const pair = (rank: number): Condition =>
      ({ kind: 'category', category: 1, royal: false, orBetter: false, rank }) as Condition;
    const high = (rank: number): Condition =>
      ({ kind: 'category', category: 0, royal: false, orBetter: false, rank }) as Condition;

    expect(check(pair(14), 'AS AD', { rank: pairOfAces })).toBe(true);
    expect(check(pair(13), 'AS AD', { rank: pairOfAces })).toBe(false);
    expect(check(high(14), 'AS KD', { rank: aceHigh })).toBe(true);
    expect(check(high(13), 'AS KD', { rank: aceHigh })).toBe(false);
  });

  it('tells a royal flush from other straight flushes', () => {
    const royal: Condition = { kind: 'category', category: 8, royal: true, orBetter: false, rank: null };
    const straightFlush: Condition = { kind: 'category', category: 8, royal: false, orBetter: false, rank: null };
    const royalRank = rankBest(cards('AS KS QS JS TS 2D 3C'));
    const nineHigh = rankBest(cards('9S 8S 7S 6S 5S 2D 3C'));
    expect(check(royal, 'AS KS', { rank: royalRank })).toBe(true);
    expect(check(royal, '9S 8S', { rank: nineHigh })).toBe(false);
    expect(check(straightFlush, '9S 8S', { rank: nineHigh })).toBe(true);
  });

  it('showdown or not', () => {
    expect(check({ kind: 'showdown', value: true }, '2S 3S', { showdown: true })).toBe(true);
    expect(check({ kind: 'showdown', value: true }, '2S 3S', { showdown: false })).toBe(false);
    expect(check({ kind: 'showdown', value: false }, '2S 3S', { showdown: false })).toBe(true);
  });

  it('pot, chips, bet and number of players', () => {
    const stat = (s: 'pot' | 'chips' | 'bet' | 'players', op: '>' | '>=' | '<' | '<=' | '=', value: number) =>
      ({ kind: 'stat', stat: s, op, value }) as Condition;
    expect(check(stat('pot', '>', 100), '2S 3S', { pot: 150 })).toBe(true);
    expect(check(stat('pot', '<', 100), '2S 3S', { pot: 150 })).toBe(false);
    expect(check(stat('chips', '<', 50), '2S 3S', { chips: 40 })).toBe(true);
    expect(check(stat('bet', '>=', 30), '2S 3S', { bet: 30 })).toBe(true);
    expect(check(stat('players', '>=', 3), '2S 3S', { others: 2 })).toBe(true);
    expect(check(stat('players', '=', 2), '2S 3S', { others: 2 })).toBe(false);
  });

  it('not, and, or', () => {
    const suited: Condition = { kind: 'shape', suited: true, connected: false };
    const connected: Condition = { kind: 'shape', suited: null, connected: true };
    expect(check({ kind: 'not', inner: suited }, '7S 2D')).toBe(true);
    expect(check({ kind: 'and', parts: [suited, connected] }, '7S 8S')).toBe(true);
    expect(check({ kind: 'and', parts: [suited, connected] }, '7S 2S')).toBe(false);
    expect(check({ kind: 'or', parts: [suited, connected] }, '7S 8D')).toBe(true);
    expect(check({ kind: 'or', parts: [suited, connected] }, '7S 2D')).toBe(false);
  });
});

describe('triggerHits', () => {
  it('knows what each kind of rule listens for', () => {
    const winner = seat('a', '2C 3D', { won: 10 });
    const loser = seat('b', '2C 3D');
    const folder = seat('c', '2C 3D', { folded: true });
    const shover = seat('d', '2C 3D', { allIn: true });

    expect(triggerHits('win', winner)).toBe(true);
    expect(triggerHits('win', loser)).toBe(false);
    expect(triggerHits('lose', loser)).toBe(true);
    expect(triggerHits('lose', winner)).toBe(false);
    expect(triggerHits('lose', folder)).toBe(true); // folding is losing
    expect(triggerHits('fold', folder)).toBe(true);
    expect(triggerHits('fold', loser)).toBe(false);
    expect(triggerHits('allin', shover)).toBe(true);
    expect(triggerHits('allin', loser)).toBe(false);
    expect(triggerHits('play', loser)).toBe(true);
  });
});

// ---------- applying rules ----------

describe('evaluateRules: transfers', () => {
  const everyonePays = make('win', [{ kind: 'transfer', from: everyone, to: subject, amount: fixed(10) }], {
    cond: hole72,
  });

  it('everyone pays the winner', () => {
    const sum = summary([seat('a', '7S 2D', { won: 30 }), seat('b', 'AS KS'), seat('c', '2C 3D')]);
    const out = evaluateRules([everyonePays], sum, players([100, 100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 120], ['b', 90], ['c', 90]]);
    expect(out.changed).toBe(true);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('Rule 1 triggered: Alice won with 7-2 offsuit.');
    expect(out.lines[0]).toContain('Bob pays Alice 10');
    expect(out.lines[0]).toContain('Cara pays Alice 10');
  });

  it('does nothing when the winning hand does not match', () => {
    const sum = summary([seat('a', 'AS KS', { won: 30 }), seat('b', '7S 2D')]);
    const out = evaluateRules([everyonePays], sum, players([100, 100]));
    expect(out.changed).toBe(false);
    expect(out.lines).toEqual([]);
    expect([...out.chips.values()]).toEqual([100, 100]);
  });

  it('players pay what they have, and the announcement says so', () => {
    const sum = summary([seat('a', '7S 2D', { won: 30 }), seat('b', 'AS KS'), seat('c', '2C 3D')]);
    const out = evaluateRules([everyonePays], sum, players([100, 4, 100]));
    expect(out.chips.get('b')).toBe(0);
    expect(out.chips.get('a')).toBe(114);
    expect(out.lines[0]).toContain("couldn't pay in full");
  });

  it('says so when nobody can pay', () => {
    const sum = summary([seat('a', '7S 2D', { won: 30 }), seat('b', 'AS KS'), seat('c', '2C 3D')]);
    const out = evaluateRules([everyonePays], sum, players([100, 0, 0]));
    expect(out.changed).toBe(false);
    expect(out.lines[0]).toContain('Nobody had chips to pay');
  });

  it('a named payer and receiver, only when the named player wins', () => {
    const r = make('win', [{ kind: 'transfer', from: only('b'), to: only('c'), amount: fixed(10) }], {
      who: { kind: 'players', playerIds: ['d'] },
    });
    const dWins = summary([seat('a', '2C 3D'), seat('d', '4C 5D', { won: 20 })]);
    const win = evaluateRules([r], dWins, players([100, 100, 100, 100]));
    expect(win.chips.get('b')).toBe(90);
    expect(win.chips.get('c')).toBe(110);

    const aWins = summary([seat('a', '2C 3D', { won: 20 }), seat('d', '4C 5D')]);
    expect(evaluateRules([r], aWins, players([100, 100, 100, 100])).changed).toBe(false);
  });

  it('the winner pays everyone else', () => {
    const r = make('win', [{ kind: 'transfer', from: subject, to: others, amount: fixed(5) }]);
    const sum = summary([seat('a', '2C 3D', { won: 20 }), seat('b', '4C 5D'), seat('c', '6C 7D')]);
    const out = evaluateRules([r], sum, players([100, 100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 90], ['b', 105], ['c', 105]]);
  });
});

describe('evaluateRules: chips from and to the bank', () => {
  it('adds chips to the winner without taking them from anyone', () => {
    const sum = summary([seat('a', '2C 3D', { won: 20 }), seat('b', '4C 5D')]);
    const out = evaluateRules([make('win', [gain(50)])], sum, players([100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 150], ['b', 100]]);
    expect(out.lines[0]).toContain('Alice gets 50');
  });

  it('takes chips from a player who folds, without paying anyone', () => {
    const r = make('fold', [{ kind: 'lose', from: subject, amount: fixed(5) }]);
    const sum = summary([seat('a', '2C 3D', { won: 20 }), seat('c', '4C 5D', { folded: true })]);
    const out = evaluateRules([r], sum, players([100, 100, 100]));
    expect(out.chips.get('c')).toBe(95);
    expect(out.chips.get('a')).toBe(100);
    expect(out.lines[0]).toContain('Rule 1 triggered: Cara folded.');
    expect(out.lines[0]).toContain('Cara loses 5');
  });

  it("only takes what a player has", () => {
    const r = make('fold', [{ kind: 'lose', from: subject, amount: fixed(5) }]);
    const sum = summary([seat('a', '2C 3D', { won: 20 }), seat('c', '4C 5D', { folded: true })]);
    const out = evaluateRules([r], sum, players([100, 100, 3]));
    expect(out.chips.get('c')).toBe(0);
    expect(out.lines[0]).toContain("couldn't pay in full");
  });

  it('sets chips to an exact number', () => {
    const r = make('win', [{ kind: 'set', target: only('b'), chips: 77 }]);
    const sum = summary([seat('a', '2C 3D', { won: 20 }), seat('b', '4C 5D')]);
    const out = evaluateRules([r], sum, players([100, 100]));
    expect(out.chips.get('b')).toBe(77);
    expect(out.lines[0]).toContain('Bob now has 77');
  });

  it('never goes above the maximum number of chips', () => {
    const sum = summary([seat('a', '2C 3D', { won: 20 }), seat('b', '4C 5D')]);
    const out = evaluateRules([make('win', [gain(100)])], sum, players([MAX_PLAYER_CHIPS - 10, 100]));
    expect(out.chips.get('a')).toBe(MAX_PLAYER_CHIPS);
  });
});

describe('evaluateRules: amounts', () => {
  const sum = (o: Partial<HandSummary> = {}) =>
    summary([seat('a', '2C 3D', { won: 20 }), seat('b', '4C 5D')], o);

  it('a share of the pot', () => {
    const half = make('win', [{ kind: 'gain', to: subject, amount: { kind: 'percent', pct: 50, of: { kind: 'pot' } } }]);
    expect(evaluateRules([half], sum({ pot: 200 }), players([100, 100])).chips.get('a')).toBe(200);
  });

  it('a share of their own chips', () => {
    const quarter = make('win', [
      { kind: 'lose', from: subject, amount: { kind: 'percent', pct: 25, of: { kind: 'own' } } },
    ]);
    expect(evaluateRules([quarter], sum(), players([100, 100])).chips.get('a')).toBe(75);
  });

  it("all of somebody else's chips", () => {
    const all = make('win', [
      {
        kind: 'transfer', from: only('b'), to: subject,
        amount: { kind: 'percent', pct: 100, of: { kind: 'chipsOf', party: only('b') } },
      },
    ]);
    const out = evaluateRules([all], sum(), players([100, 80]));
    expect([...out.chips.entries()]).toEqual([['a', 180], ['b', 0]]);
  });

  it('rounds fractions down', () => {
    const r = make('win', [{ kind: 'gain', to: subject, amount: { kind: 'percent', pct: 10, of: { kind: 'pot' } } }]);
    expect(evaluateRules([r], sum({ pot: 25 }), players([100, 100])).chips.get('a')).toBe(102);
  });
});

describe('evaluateRules: who triggers a rule', () => {
  const sum = summary([
    seat('a', '2C 3D', { won: 30 }),
    seat('b', '4C 5D', { allIn: true }),
    seat('c', '6C 7D', { folded: true }),
  ]);

  it('losing includes folding', () => {
    const out = evaluateRules([make('lose', [{ kind: 'lose', from: subject, amount: fixed(5) }])], sum, players([100, 100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 100], ['b', 95], ['c', 95]]);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toContain('Bob lost');
  });

  it('going all in', () => {
    const out = evaluateRules([make('allin', [gain(5)])], sum, players([100, 100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 100], ['b', 105], ['c', 100]]);
  });

  it('playing, limited to named players', () => {
    const r = make('play', [gain(1)], { who: { kind: 'players', playerIds: ['c'] } });
    const out = evaluateRules([r], sum, players([100, 100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 100], ['b', 100], ['c', 101]]);
  });

  it('every winner of a split pot triggers the rule', () => {
    const split = summary([seat('a', '2C 3D', { won: 10 }), seat('b', '4C 5D', { won: 10 })]);
    const out = evaluateRules([make('win', [gain(5)])], split, players([100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 105], ['b', 105]]);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toContain('Rule 1 triggered: Alice won.');
    expect(out.lines[1]).toContain('Rule 1 triggered: Bob won.');
  });

  it('skips rules that name a player who has left', () => {
    const r = make('win', [{ kind: 'transfer', from: only('ghost'), to: subject, amount: fixed(10) }]);
    const out = evaluateRules([r], sum, players([100, 100, 100]));
    expect(out.changed).toBe(false);
    expect(out.lines).toEqual([]);
  });
});

describe('evaluateRules: several effects and several rules', () => {
  it('runs every effect of a rule, in order', () => {
    const r = make('win', [gain(50), { kind: 'lose', from: others, amount: fixed(5) }]);
    const sum = summary([seat('a', '2C 3D', { won: 30 }), seat('b', '4C 5D'), seat('c', '6C 7D')]);
    const out = evaluateRules([r], sum, players([100, 100, 100]));
    expect([...out.chips.entries()]).toEqual([['a', 150], ['b', 95], ['c', 95]]);
    expect(out.lines).toEqual(['Rule 1 triggered: Alice won. Alice gets 50, Bob loses 5, Cara loses 5.']);
  });

  it('later rules see the chips left by earlier ones, and rules are numbered', () => {
    const first = make('win', [{ kind: 'transfer', from: others, to: subject, amount: fixed(10) }]);
    const second = make('win', [gain(1)], {
      cond: { kind: 'stat', stat: 'chips', op: '>=', value: 110 },
    });
    const sum = summary([seat('a', '2C 3D', { won: 30 }), seat('b', '4C 5D')]);
    const out = evaluateRules([first, second], sum, players([100, 100]));
    expect(out.chips.get('a')).toBe(111);
    expect(out.lines[0]).toContain('Rule 1');
    expect(out.lines[1]).toContain('Rule 2');
  });

  it('property: transfers never create or destroy chips, and nobody goes negative', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 2, maxLength: 6 }),
        fc.integer({ min: 1, max: 200 }),
        fc.nat(5),
        (chipList, amount, pick) => {
          const winner = pick % chipList.length;
          const rules: Rule[] = [
            make('win', [{ kind: 'transfer', from: everyone, to: subject, amount: fixed(amount) }]),
            make('lose', [
              {
                kind: 'transfer', from: subject, to: others,
                amount: { kind: 'percent', pct: 50, of: { kind: 'own' } },
              },
            ]),
          ];
          const seats = chipList.map((_, i) => seat(IDS[i]!, '2C 3D', i === winner ? { won: 10 } : {}));
          const out = evaluateRules(rules, summary(seats), players(chipList));
          expect(total(out.chips)).toBe(chipList.reduce((a, b) => a + b, 0));
          for (const v of out.chips.values()) expect(v).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------- describing rules ----------

describe('describeRule', () => {
  const names = (id: string) => ({ a: 'Alice', b: 'Bob', c: 'Cara', d: 'Dan' } as Record<string, string>)[id] ?? null;
  const text = (r: Rule) => describeRule(r, names).text;

  it('writes the classic rule in plain words', () => {
    const r = make('win', [{ kind: 'transfer', from: everyone, to: subject, amount: fixed(10) }], { cond: hole72 });
    expect(describeRule(r, names)).toEqual({
      text: 'If someone wins with 7-2 offsuit: everyone else pays the winner 10 chips each.',
      active: true,
    });
  });

  it('writes named players, hands and big numbers', () => {
    const r = make('win', [{ kind: 'transfer', from: only('a'), to: only('b'), amount: fixed(1000) }], {
      who: { kind: 'players', playerIds: ['c'] },
      cond: { kind: 'category', category: 5, royal: false, orBetter: false, rank: null },
    });
    expect(text(r)).toBe('If Cara wins with a flush: Alice pays Bob 1,000 chips.');
    expect(
      text(make('win', [gain(5)], { cond: { kind: 'hole', high: 14, low: 14, suited: 'any' } })),
    ).toContain('with pocket aces');
  });

  it('chips from and to the bank, and exact amounts', () => {
    expect(text(make('win', [gain(50)]))).toBe('If someone wins: the winner gets 50 chips.');
    expect(text(make('fold', [{ kind: 'lose', from: subject, amount: fixed(5) }]))).toBe(
      'If someone folds: the player who folded loses 5 chips.',
    );
    expect(text(make('win', [{ kind: 'set', target: only('b'), chips: 100 }]))).toBe(
      'If someone wins: Bob is set to 100 chips.',
    );
  });

  it('shares of the pot and of chips', () => {
    expect(
      text(make('win', [{ kind: 'gain', to: subject, amount: { kind: 'percent', pct: 50, of: { kind: 'pot' } } }])),
    ).toBe('If someone wins: the winner gets half of the pot.');
    expect(
      text(make('lose', [{ kind: 'lose', from: subject, amount: { kind: 'percent', pct: 25, of: { kind: 'own' } } }])),
    ).toBe('If someone loses: the loser loses 25% of their chips.');
  });

  it('groups of players', () => {
    expect(text(make('win', [gain(5)], { who: { kind: 'players', playerIds: ['b', 'c'] } }))).toBe(
      'If Bob or Cara wins: the winner gets 5 chips.',
    );
    expect(text(make('win', [{ kind: 'transfer', from: only('b', 'c'), to: only('d'), amount: fixed(5) }]))).toBe(
      'If someone wins: Bob and Cara pay Dan 5 chips each.',
    );
    expect(text(make('win', [{ kind: 'transfer', from: subject, to: others, amount: fixed(5) }]))).toBe(
      'If someone wins: the winner pays everyone else 5 chips each.',
    );
  });

  it('conditions', () => {
    const flush: Condition = { kind: 'category', category: 5, royal: false, orBetter: false, rank: null };
    const withCond = (c: Condition) => text(make('win', [gain(5)], { cond: c }));

    expect(withCond({ kind: 'not', inner: flush })).toBe('If someone wins without a flush: the winner gets 5 chips.');
    expect(withCond({ kind: 'showdown', value: false })).toBe(
      'If someone wins when everyone else folds: the winner gets 5 chips.',
    );
    expect(withCond({ kind: 'stat', stat: 'pot', op: '>', value: 100 })).toBe(
      'If someone wins when the pot is more than 100: the winner gets 5 chips.',
    );
    expect(withCond({ kind: 'board', match: { rank: 14 }, count: 1 })).toBe(
      'If someone wins when the board has an ace: the winner gets 5 chips.',
    );
    expect(
      withCond({ kind: 'and', parts: [flush, { kind: 'cards', match: { rank: 14, suit: 'S' }, count: 1 }] }),
    ).toBe('If someone wins with a flush and the ace of spades: the winner gets 5 chips.');
    expect(withCond({ kind: 'shape', suited: true, connected: true })).toBe(
      'If someone wins with suited connectors: the winner gets 5 chips.',
    );
    expect(withCond({ kind: 'cards', match: { suit: 'H' }, count: 2 })).toContain('with two hearts');
    expect(withCond({ kind: 'cards', match: { color: 'red' }, count: 1 })).toContain('with a red card');
  });

  it('other triggers', () => {
    expect(text(make('allin', [gain(5)]))).toBe(
      'If someone goes all in: the player who went all in gets 5 chips.',
    );
  });

  it('marks a rule inactive when a player in it has left', () => {
    const r = make('win', [gain(5)], { who: { kind: 'players', playerIds: ['ghost'] } });
    const d = describeRule(r, names);
    expect(d.active).toBe(false);
    expect(d.text).toContain('a player who left');
  });

  it('lists every player a rule mentions', () => {
    const r = make(
      'win',
      [
        {
          kind: 'transfer', from: only('c'), to: subject,
          amount: { kind: 'percent', pct: 100, of: { kind: 'chipsOf', party: only('d') } },
        },
      ],
      { who: { kind: 'players', playerIds: ['b'] } },
    );
    expect(ruleReferencedIds(r)).toEqual(['b', 'c', 'd']);
  });
});