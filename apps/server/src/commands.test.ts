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

const EVERYONE_PAYS = { from: { kind: 'everyone' }, to: { kind: 'winner' }, amount: 10 };

describe('the two example rules', () => {
  it('"if someone wins with 2 7 offsuit then everyone pays them 10 chips"', () => {
    expect(rule('/rule if someone wins with 2 7 offsuit then everyone pays them 10 chips')).toEqual({
      who: { kind: 'anyone' },
      hand: { kind: 'hole', high: 7, low: 2, suited: 'offsuit' },
      effect: EVERYONE_PAYS,
    });
  });

  it('"every time player 4 wins player two gives player 3 10 chips"', () => {
    expect(rule('/rule every time player 4 wins player two gives player 3 10 chips')).toEqual({
      who: { kind: 'player', playerId: 'd' },
      hand: null,
      effect: { from: { kind: 'player', playerId: 'b' }, to: { kind: 'player', playerId: 'c' }, amount: 10 },
    });
  });
});

describe('hands', () => {
  const hand = (clause: string) => rule(`/rule if someone wins with ${clause} then everyone pays them 10 chips`).hand;
  const hole = (high: number, low: number, suited: string) => ({ kind: 'hole', high, low, suited });

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
    ['a flush', { kind: 'category', category: 5, royal: false }],
    ['a straight', { kind: 'category', category: 4, royal: false }],
    ['a full house', { kind: 'category', category: 6, royal: false }],
    ['four of a kind', { kind: 'category', category: 7, royal: false }],
    ['three of a kind', { kind: 'category', category: 3, royal: false }],
    ['trips', { kind: 'category', category: 3, royal: false }],
    ['two pair', { kind: 'category', category: 2, royal: false }],
    ['a pair', { kind: 'category', category: 1, royal: false }],
    ['a straight flush', { kind: 'category', category: 8, royal: false }],
    ['a royal flush', { kind: 'category', category: 8, royal: true }],
  ])('"%s"', (clause, expected) => {
    expect(hand(clause)).toEqual(expected);
  });

  it('is not case sensitive and accepts a comma instead of "then"', () => {
    expect(rule('/rule If Someone Wins With 7 2 Offsuit, Everyone Pays Them 10 Chips').hand).toEqual(
      hole(7, 2, 'offsuit'),
    );
  });

  it('works without a separator', () => {
    expect(rule('/rule if someone wins with a flush everyone pays them 10 chips').hand).toEqual({
      kind: 'category', category: 5, royal: false,
    });
  });
});

describe('who and what', () => {
  it('understands different ways to say who wins', () => {
    expect(rule('/rule if Bob wins then Cara pays Dan 3').who).toEqual({ kind: 'player', playerId: 'b' });
    expect(rule('/rule if I win then everyone pays me 10').who).toEqual({ kind: 'player', playerId: 'a' });
    expect(rule('/rule when anyone wins the pot then Bob pays Cara 5').who).toEqual({ kind: 'anyone' });
  });

  it('understands different payouts', () => {
    expect(rule('/rule if someone wins then the winner pays everyone 5 chips').effect).toEqual({
      from: { kind: 'winner' }, to: { kind: 'everyone' }, amount: 5,
    });
    expect(rule('/rule when player 2 wins player 3 gets 20 chips from everyone').effect).toEqual({
      from: { kind: 'everyone' }, to: { kind: 'player', playerId: 'c' }, amount: 20,
    });
    expect(rule('/rule if someone wins then player 2 gives 10 chips to player 3').effect).toEqual({
      from: { kind: 'player', playerId: 'b' }, to: { kind: 'player', playerId: 'c' }, amount: 10,
    });
    expect(rule('/rule if someone wins then everyone pays them 1,000 chips each').effect.amount).toBe(1000);
  });

  it('matches names, longest first, including names with spaces', () => {
    const c: ParseContext = {
      players: [{ id: 'x', name: 'Bob' }, { id: 'y', name: 'Big Bob' }],
      hostId: 'x',
    };
    expect(rule('/rule if Big Bob wins then Bob pays them 5', c)).toMatchObject({
      who: { kind: 'player', playerId: 'y' },
      effect: { from: { kind: 'player', playerId: 'x' } },
    });
  });
});

describe('rule errors', () => {
  it('explains what is wrong', () => {
    expect(err('/rule someone wins then everyone pays them 10')).toContain('starts with');
    expect(err('/rule if banana wins then everyone pays them 10')).toContain('expected who wins');
    expect(err('/rule if someone then everyone pays them 10')).toContain('expected "wins"');
    expect(err('/rule if someone wins with a banana then everyone pays them 10')).toContain('understand the hand');
    expect(err('/rule if someone wins with 7 2 offsuit')).toContain('What should happen');
    expect(err('/rule if someone wins then dance')).toContain('understand the payout');
    expect(err('/rule if someone wins then everyone pays them')).toContain('How many chips');
    expect(err('/rule if someone wins then everyone pays everyone 10')).toContain('both sides');
    expect(err('/rule if someone wins then player 2 gives player 2 10')).toContain('pay themselves');
    expect(err('/rule if someone wins then everyone pays them 10 chips please')).toContain('at the end');
    expect(err('/rule if someone wins with 77 suited then everyone pays them 10')).toContain("can't be suited");
    expect(err('/rule if player 9 wins then everyone pays them 10')).toContain('There is no player 9');
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

  it('chips', () => {
    expect(ok('/chips Bob 500')).toEqual({ kind: 'setChips', playerId: 'b', chips: 500 });
    expect(ok('/chips player 2 to 1,000')).toEqual({ kind: 'setChips', playerId: 'b', chips: 1000 });
    expect(ok('/chips Bob 0')).toEqual({ kind: 'setChips', playerId: 'b', chips: 0 });
    expect(err('/chips Bob')).toContain('How many chips');
    expect(err('/chips Bob -5')).toContain('How many chips');
    expect(err('/chips Bob 5000000')).toContain('whole numbers');
    expect(err('/chips 500')).toContain('Who?');
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