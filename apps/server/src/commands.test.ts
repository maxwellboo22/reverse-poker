import { describe, it, expect } from 'vitest';
import { parseCommand, type Command, type ParseContext } from './game/commands';
import type { Rule } from './game/rules';

const ctx: ParseContext = {
  players: [
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob' },
    { id: 'c', name: 'Cara' },
    { id: 'd', name: 'Dan' },
  ],
  hostId: 'a',
};

function ok(text: string, c: ParseContext = ctx): Command {
  const r = parseCommand(text, c);
  if (!r.ok) throw new Error(`expected "${text}" to parse, got: ${r.error}`);
  return r.command;
}

function rule(text: string, c: ParseContext = ctx): Rule {
  const cmd = ok(text, c);
  if (cmd.kind !== 'addRule') throw new Error(`"${text}" is not a rule`);
  return cmd.rule;
}

function err(text: string, c: ParseContext = ctx): string {
  const r = parseCommand(text, c);
  if (r.ok) throw new Error(`expected "${text}" to fail`);
  return r.error;
}

// helpers that build the expected objects
const fixed = (n: number) => ({ kind: 'fixed', n });
const only = (...ids: string[]) => ({ kind: 'players', playerIds: ids });
const hole = (high: number, low: number, suited: string) => ({ kind: 'hole', high, low, suited });
const category = (cat: number, extra: object = {}) => ({
  kind: 'category', category: cat, royal: false, orBetter: false, rank: null, ...extra,
});
const cards = (rank: number, suit: string, count = 1) => ({ kind: 'cards', match: { rank, suit }, count });

/** The condition of "if someone wins with <clause> then everyone pays them 10 chips". */
const cond = (clause: string) =>
  rule(`/rule if someone wins with ${clause} then everyone pays them 10 chips`).cond;

/** The condition of "if someone wins when <clause> then everyone pays them 10 chips". */
const when = (clause: string) =>
  rule(`/rule if someone wins when ${clause} then everyone pays them 10 chips`).cond;

describe('the two example rules', () => {
  it('"if someone wins with 2 7 offsuit then everyone pays them 10 chips"', () => {
    expect(rule('/rule if someone wins with 2 7 offsuit then everyone pays them 10 chips')).toEqual({
      trigger: 'win',
      who: { kind: 'anyone' },
      cond: hole(7, 2, 'offsuit'),
      effects: [{ kind: 'transfer', from: { kind: 'everyone' }, to: { kind: 'subject' }, amount: fixed(10) }],
    });
  });

  it('"every time player 4 wins player two gives player 3 10 chips"', () => {
    expect(rule('/rule every time player 4 wins player two gives player 3 10 chips')).toEqual({
      trigger: 'win',
      who: only('d'),
      cond: null,
      effects: [{ kind: 'transfer', from: only('b'), to: only('c'), amount: fixed(10) }],
    });
  });
});

describe('two-card hands', () => {
  it.each([
    ['7 2 offsuit', hole(7, 2, 'offsuit')],
    ['7-2 offsuit', hole(7, 2, 'offsuit')],
    ['7/2 off suit', hole(7, 2, 'offsuit')],
    ['a seven and a two offsuited', hole(7, 2, 'offsuit')],
    ['72o', hole(7, 2, 'offsuit')],
    ['72s', hole(7, 2, 'suited')],
    ['7 2', hole(7, 2, 'any')],
    ['10 2 unsuited', hole(10, 2, 'offsuit')],
    ['T9s', hole(10, 9, 'suited')],
    ['ace king suited', hole(14, 13, 'suited')],
    ['AKs', hole(14, 13, 'suited')],
    ['ak suited', hole(14, 13, 'suited')],
    ['K K', hole(13, 13, 'any')],
    ['77', hole(7, 7, 'any')],
    ['pocket aces', hole(14, 14, 'any')],
    ['pocket 7s', hole(7, 7, 'any')],
    ['pocket sixes', hole(6, 6, 'any')],
    ['a pocket pair', { kind: 'pocketPair' }],
  ])('"%s"', (clause, expected) => {
    expect(cond(clause)).toEqual(expected);
  });

  it('is not case sensitive and accepts a comma instead of "then"', () => {
    expect(rule('/rule If Someone Wins With 7 2 Offsuit, Everyone Pays Them 10 Chips').cond).toEqual(
      hole(7, 2, 'offsuit'),
    );
  });

  it('works without a separator', () => {
    expect(rule('/rule if someone wins with a flush everyone pays them 10 chips').cond).toEqual(category(5));
  });
});

describe('hand names', () => {
  it.each([
    ['a flush', category(5)],
    ['a straight', category(4)],
    ['a full house', category(6)],
    ['four of a kind', category(7)],
    ['three of a kind', category(3)],
    ['trips', category(3)],
    ['two pair', category(2)],
    ['a pair', category(1)],
    ['a straight flush', category(8)],
    ['a royal flush', category(8, { royal: true })],
    ['a flush or better', category(5, { orBetter: true })],
    ['a pair of aces', category(1, { rank: 14 })],
    ['ace high', category(0, { rank: 14 })],
  ])('"%s"', (clause, expected) => {
    expect(cond(clause)).toEqual(expected);
  });
});

describe('specific cards and groups of cards', () => {
  it.each([
    ['the ace of spades', cards(14, 'S')],
    ['As Kh', { kind: 'and', parts: [cards(14, 'S'), cards(13, 'H')] }],
    ['7h', cards(7, 'H')],
    ['two hearts', { kind: 'cards', match: { suit: 'H' }, count: 2 }],
    ['a red card', { kind: 'cards', match: { color: 'red' }, count: 1 }],
    ['a face card', { kind: 'cards', match: { minRank: 11, maxRank: 13 }, count: 1 }],
    ['a ten or higher', { kind: 'cards', match: { minRank: 10 }, count: 1 }],
    ['an ace', { kind: 'cards', match: { rank: 14 }, count: 1 }],
    ['suited cards', { kind: 'shape', suited: true, connected: false }],
    ['offsuit cards', { kind: 'shape', suited: false, connected: false }],
    ['suited connectors', { kind: 'shape', suited: true, connected: true }],
    ['connectors', { kind: 'shape', suited: null, connected: true }],
  ])('"%s"', (clause, expected) => {
    expect(cond(clause)).toEqual(expected);
  });
});

describe('other conditions', () => {
  it('the pot, chips, bets and players', () => {
    expect(when('the pot is over 100')).toEqual({ kind: 'stat', stat: 'pot', op: '>', value: 100 });
    expect(when('the pot > 100')).toEqual({ kind: 'stat', stat: 'pot', op: '>', value: 100 });
    expect(when('they have under 50 chips')).toEqual({ kind: 'stat', stat: 'chips', op: '<', value: 50 });
    expect(when('they have 100 chips or more')).toEqual({ kind: 'stat', stat: 'chips', op: '>=', value: 100 });
    expect(when('they bet more than 20')).toEqual({ kind: 'stat', stat: 'bet', op: '>', value: 20 });
    expect(when('there are at least 3 players')).toEqual({ kind: 'stat', stat: 'players', op: '>=', value: 3 });
    expect(when('heads up')).toEqual({ kind: 'stat', stat: 'players', op: '=', value: 2 });
  });

  it('the board', () => {
    expect(when('the board has an ace')).toEqual({ kind: 'board', match: { rank: 14 }, count: 1 });
  });

  it('showdown or not', () => {
    expect(rule('/rule if someone wins at showdown then everyone pays them 10 chips').cond).toEqual({
      kind: 'showdown', value: true,
    });
    expect(rule('/rule if someone wins without a showdown then everyone pays them 10 chips').cond).toEqual({
      kind: 'showdown', value: false,
    });
  });

  it('"without" and "not" turn a condition around', () => {
    expect(rule('/rule if someone wins without a flush then everyone pays them 10 chips').cond).toEqual({
      kind: 'not', inner: category(5),
    });
    expect(rule('/rule if someone wins not a flush then everyone pays them 10 chips').cond).toEqual({
      kind: 'not', inner: category(5),
    });
  });

  it('"and" and "or", with "and" binding tighter', () => {
    expect(cond('a flush and the ace of spades')).toEqual({ kind: 'and', parts: [category(5), cards(14, 'S')] });
    expect(cond('a flush or a straight')).toEqual({ kind: 'or', parts: [category(5), category(4)] });
    expect(cond('a pair and the pot is over 100 or a flush')).toEqual({
      kind: 'or',
      parts: [
        { kind: 'and', parts: [category(1), { kind: 'stat', stat: 'pot', op: '>', value: 100 }] },
        category(5),
      ],
    });
  });
});

describe('triggers: who it applies to and what they did', () => {
  it.each([
    ['/rule if someone wins then everyone pays them 5', 'win'],
    ['/rule if someone loses then everyone pays them 5', 'lose'],
    ['/rule if someone folds then everyone pays them 5', 'fold'],
    ['/rule if someone goes all in then everyone pays them 5', 'allin'],
    ['/rule if someone plays then everyone pays them 5', 'play'],
  ])('%s', (text, trigger) => {
    expect(rule(text).trigger).toBe(trigger);
  });

  it('"is dealt" and "has" start a condition', () => {
    const r = rule('/rule if someone is dealt suited connectors then take 10 chips from everyone');
    expect(r.trigger).toBe('play');
    expect(r.cond).toEqual({ kind: 'shape', suited: true, connected: true });
    expect(r.effects).toEqual([{ kind: 'lose', from: { kind: 'everyone' }, amount: fixed(10) }]);
  });

  it('names, "player 3", "me", and lists of players', () => {
    expect(rule('/rule if Bob loses then Cara pays Bob 5').who).toEqual(only('b'));
    expect(rule('/rule if Bob or Cara wins then everyone pays Dan 5').who).toEqual(only('b', 'c'));
    const mine = rule('/rule if I win then everyone pays me 10');
    expect(mine.who).toEqual(only('a'));
    expect(mine.effects[0]).toEqual({
      kind: 'transfer', from: { kind: 'everyone' }, to: only('a'), amount: fixed(10),
    });
  });

  it('matches names longest first, including names with spaces', () => {
    const c: ParseContext = {
      players: [{ id: 'x', name: 'Bob' }, { id: 'y', name: 'Big Bob' }],
      hostId: 'x',
    };
    expect(rule('/rule if Big Bob wins then Bob pays them 5', c)).toMatchObject({
      who: only('y'),
      effects: [{ kind: 'transfer', from: only('x') }],
    });
  });

  it('lets "and" join the trigger to the payout', () => {
    const r = rule('/rule if someone wins and everyone pays them 10');
    expect(r.cond).toBeNull();
    expect(r.effects).toHaveLength(1);
  });
});

describe('payouts', () => {
  const effects = (payout: string) => rule(`/rule if someone wins then ${payout}`).effects;

  it('transfers between players', () => {
    expect(effects('Bob gives Cara 10')).toEqual([
      { kind: 'transfer', from: only('b'), to: only('c'), amount: fixed(10) },
    ]);
    expect(effects('everyone else pays them 10')).toEqual([
      { kind: 'transfer', from: { kind: 'others' }, to: { kind: 'subject' }, amount: fixed(10) },
    ]);
    expect(effects('Bob and Cara pay Dan 5')).toEqual([
      { kind: 'transfer', from: only('b', 'c'), to: only('d'), amount: fixed(5) },
    ]);
    expect(effects('they get 20 chips from everyone')).toEqual([
      { kind: 'transfer', from: { kind: 'everyone' }, to: { kind: 'subject' }, amount: fixed(20) },
    ]);
    expect(effects('everyone pays them 10 chips each')).toEqual([
      { kind: 'transfer', from: { kind: 'everyone' }, to: { kind: 'subject' }, amount: fixed(10) },
    ]);
  });

  it('chips from or to nobody (the bank)', () => {
    expect(effects('they get 50 chips')).toEqual([{ kind: 'gain', to: { kind: 'subject' }, amount: fixed(50) }]);
    expect(effects('give them 50 chips')).toEqual([{ kind: 'gain', to: { kind: 'subject' }, amount: fixed(50) }]);
    expect(effects('give 50 chips to Bob')).toEqual([{ kind: 'gain', to: only('b'), amount: fixed(50) }]);
    expect(effects('they lose 20 chips')).toEqual([{ kind: 'lose', from: { kind: 'subject' }, amount: fixed(20) }]);
    expect(effects('take 10 chips from everyone')).toEqual([{ kind: 'lose', from: { kind: 'everyone' }, amount: fixed(10) }]);
    expect(effects('fine them 5 chips')).toEqual([{ kind: 'lose', from: { kind: 'subject' }, amount: fixed(5) }]);
  });

  it('setting chips to an exact number', () => {
    expect(effects(`Bob's chips are set to 100`)).toEqual([{ kind: 'set', target: only('b'), chips: 100 }]);
    expect(effects(`set Bob's chips to 100`)).toEqual([{ kind: 'set', target: only('b'), chips: 100 }]);
    expect(effects('they have 0 chips')).toEqual([{ kind: 'set', target: { kind: 'subject' }, chips: 0 }]);
  });

  it('amounts as a share of the pot or of somebody\'s chips', () => {
    expect(effects('the winner gives Bob half of the pot')).toEqual([
      {
        kind: 'transfer', from: { kind: 'subject' }, to: only('b'),
        amount: { kind: 'percent', pct: 50, of: { kind: 'pot' } },
      },
    ]);
    expect(effects('they pay Bob 25% of their chips')).toEqual([
      {
        kind: 'transfer', from: { kind: 'subject' }, to: only('b'),
        amount: { kind: 'percent', pct: 25, of: { kind: 'own' } },
      },
    ]);
    expect(effects(`Bob pays them all of Bob's chips`)).toEqual([
      {
        kind: 'transfer', from: only('b'), to: { kind: 'subject' },
        amount: { kind: 'percent', pct: 100, of: { kind: 'chipsOf', party: only('b') } },
      },
    ]);
  });

  it('several payouts in one rule', () => {
    expect(effects('they get 50 chips and everyone pays them 5')).toEqual([
      { kind: 'gain', to: { kind: 'subject' }, amount: fixed(50) },
      { kind: 'transfer', from: { kind: 'everyone' }, to: { kind: 'subject' }, amount: fixed(5) },
    ]);
    expect(effects('everyone pays them 5 and Bob gets 3')).toEqual([
      { kind: 'transfer', from: { kind: 'everyone' }, to: { kind: 'subject' }, amount: fixed(5) },
      { kind: 'gain', to: only('b'), amount: fixed(3) },
    ]);
  });

  it('limits how many payouts one rule can have', () => {
    const seven = Array(7).fill('they get 1 chip').join(' and ');
    expect(err(`/rule if someone wins then ${seven}`)).toContain('at most 6');
    const six = Array(6).fill('they get 1 chip').join(' and ');
    expect(rule(`/rule if someone wins then ${six}`).effects).toHaveLength(6);
  });
});

describe('rule errors', () => {
  it('explains what is wrong', () => {
    expect(err('/rule someone wins then everyone pays them 10')).toContain('starts with');
    expect(err('/rule if banana wins then everyone pays them 10')).toContain('expected who it applies to');
    expect(err('/rule if someone then everyone pays them 10')).toContain('I expected "wins"');
    expect(err('/rule if someone wins with a banana then everyone pays them 10')).toContain(
      'understand the condition',
    );
    expect(err('/rule if someone wins with 7 2 offsuit')).toContain('What should happen');
    expect(err('/rule if someone wins then dance')).toContain('understand the payout');
    expect(err('/rule if someone wins then everyone pays them')).toContain('How many chips');
    expect(err('/rule if someone wins then everyone pays everyone 10')).toContain('both sides');
    expect(err('/rule if someone wins then player 2 gives player 2 10')).toContain('pay themselves');
    expect(err('/rule if someone wins then everyone pays them 10 chips please')).toContain('at the end');
    expect(err('/rule if someone wins with 77 suited then everyone pays them 10')).toContain("can't be suited");
    expect(err('/rule if player 9 wins then everyone pays them 10')).toContain('There is no player 9');
    expect(err('/rule if someone wins with three hearts then everyone pays them 10')).toContain(
      'only hold two cards',
    );
  });

  it('rejects amounts that are zero or too large', () => {
    expect(err('/rule if someone wins then everyone pays them 0 chips')).toContain('whole numbers');
    expect(err('/rule if someone wins then everyone pays them 2,000,000 chips')).toContain('whole numbers');
  });

  it('needs something after /rule', () => {
    expect(err('/rule')).toContain('Say what the rule is');
  });
});

describe('other commands', () => {
  it('help, lists and settings', () => {
    expect(ok('/help')).toEqual({ kind: 'help' });
    expect(ok('/rules')).toEqual({ kind: 'listRules' });
    expect(ok('/settings')).toEqual({ kind: 'showSettings' });
  });

  it('removing rules', () => {
    expect(ok('/remove rule 2')).toEqual({ kind: 'removeRule', number: 2 });
    expect(ok('/remove 2')).toEqual({ kind: 'removeRule', number: 2 });
    expect(ok('/clear rules')).toEqual({ kind: 'clearRules' });
    expect(err('/remove banana')).toContain('Which rule');
    expect(err('/clear everything')).toContain('/clear rules');
  });

  it('kick', () => {
    expect(ok('/kick Bob')).toEqual({ kind: 'kick', playerId: 'b' });
    expect(ok('/kick player 3')).toEqual({ kind: 'kick', playerId: 'c' });
    expect(err('/kick nobody')).toContain('Who?');
    expect(err('/kick Bob please')).toContain('Who?');
  });

  it('/chips sets, adds or removes chips for one player, several, or everyone', () => {
    expect(ok('/chips Bob 500')).toEqual({ kind: 'chips', playerIds: ['b'], mode: 'set', amount: 500 });
    expect(ok('/chips Bob 0')).toEqual({ kind: 'chips', playerIds: ['b'], mode: 'set', amount: 0 });
    expect(ok('/chips player 2 to 1,000')).toEqual({ kind: 'chips', playerIds: ['b'], mode: 'set', amount: 1000 });
    expect(ok('/chips Bob +50')).toEqual({ kind: 'chips', playerIds: ['b'], mode: 'add', amount: 50 });
    expect(ok('/chips Bob -20')).toEqual({ kind: 'chips', playerIds: ['b'], mode: 'add', amount: -20 });
    expect(ok('/chips everyone 500')).toEqual({
      kind: 'chips', playerIds: ['a', 'b', 'c', 'd'], mode: 'set', amount: 500,
    });
    expect(ok('/chips Bob and Cara 500')).toEqual({
      kind: 'chips', playerIds: ['b', 'c'], mode: 'set', amount: 500,
    });
    expect(err('/chips Bob')).toContain('How many chips');
    expect(err('/chips Bob 5000000')).toContain('whole numbers');
    expect(err('/chips 500')).toContain('Who?');
  });

  it('/give and /take', () => {
    expect(ok('/give Bob 50')).toEqual({ kind: 'chips', playerIds: ['b'], mode: 'add', amount: 50 });
    expect(ok('/give everyone 100')).toEqual({
      kind: 'chips', playerIds: ['a', 'b', 'c', 'd'], mode: 'add', amount: 100,
    });
    expect(ok('/take Bob 20')).toEqual({ kind: 'chips', playerIds: ['b'], mode: 'add', amount: -20 });
    expect(ok('/give 50 chips to Bob')).toEqual({ kind: 'chips', playerIds: ['b'], mode: 'add', amount: 50 });
    expect(ok('/take 10 chips from everyone')).toEqual({
      kind: 'chips', playerIds: ['a', 'b', 'c', 'd'], mode: 'add', amount: -10,
    });
    expect(err('/give Bob')).toContain('How many chips');
    expect(err('/give 50')).toContain('Who?');
  });

  it('reset', () => {
    expect(ok('/reset')).toEqual({ kind: 'reset' });
    expect(err('/reset now')).toContain('no extra words');
  });

  it('game settings', () => {
    expect(ok('/blinds 25/50')).toEqual({ kind: 'setBlinds', smallBlind: 25, bigBlind: 50 });
    expect(ok('/blinds 25 50')).toEqual({ kind: 'setBlinds', smallBlind: 25, bigBlind: 50 });
    expect(err('/blinds 25')).toContain('both blinds');
    expect(ok('/minraise 100')).toEqual({ kind: 'setMinRaise', amount: 100 });
    expect(ok('/rounds 2')).toEqual({ kind: 'setRounds', rounds: 2 });
    expect(err('/rounds 5')).toContain('1, 2, 3 or 4');
    expect(ok('/wrap on')).toEqual({ kind: 'setWrap', on: true });
    expect(ok('/wrap off')).toEqual({ kind: 'setWrap', on: false });
    expect(err('/wrap maybe')).toContain('on or off');
  });

  it('unknown commands point at /help', () => {
    expect(err('/banana')).toContain('/help');
  });
});