import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { ClientAction } from '@reverse-poker/shared';
import { computeLegalActions } from './betting';
import { applyAction, startHand, totalChips } from './hand';
import { pickAction } from './random-play';
import { seededRng, stackedDeck } from './test-utils';
import type { HandState } from './types';

type Step = [string, ClientAction];

const players = (stacks: number[]) =>
  stacks.map((stack, i) => ({ playerId: `p${i}`, name: `P${i}`, stack }));

const check: ClientAction = { type: 'check' };
const call: ClientAction = { type: 'call' };
const raiseTo = (amount: number): ClientAction => ({ type: 'raise', amount });
const key = (c: { rank: number; suit: string }) => `${c.rank}${c.suit}`;

function act(state: HandState, playerId: string, action: ClientAction): HandState {
  const r = applyAction(state, playerId, action);
  if (!r.ok) throw new Error(`${playerId} ${action.type} rejected: ${r.error}`);
  return r.state;
}

const play = (state: HandState, steps: Step[]) => steps.reduce((st, [who, a]) => act(st, who, a), state);

describe('custom blinds', () => {
  it('posts them and sets the default minimum raise to the big blind', () => {
    const s = startHand({
      players: players([1000, 1000, 1000]), buttonSeat: 0, smallBlind: 25, bigBlind: 50, rng: seededRng(1),
    });
    expect(s.seats.map((x) => x.stack)).toEqual([1000, 975, 950]);
    expect(s.currentBet).toBe(50);
    expect(s.minRaise).toBe(50);
    expect(computeLegalActions(s, 0)).toMatchObject({ callAmount: 50, minRaiseTo: 100 });
  });
});

describe('custom minimum raise', () => {
  const start = () =>
    startHand({
      players: players([1000, 1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, minRaise: 40, rng: seededRng(2),
    });

  it('applies to the pre-flop raise and to the raise after it', () => {
    let s = start();
    expect(computeLegalActions(s, 0)!.minRaiseTo).toBe(50);
    expect(applyAction(s, 'p0', raiseTo(49))).toEqual({ ok: false, error: 'illegal_raise' });
    s = act(s, 'p0', raiseTo(50));
    expect(s.lastRaiseSize).toBe(40);
    expect(computeLegalActions(s, 1)!.minRaiseTo).toBe(90);
  });

  it('is the smallest opening bet on later streets', () => {
    const s = play(start(), [['p0', call], ['p1', call], ['p2', check]]);
    expect(s.phase).toBe('flop');
    expect(computeLegalActions(s, 1)!.minRaiseTo).toBe(40);
  });
});

describe('number of betting rounds', () => {
  const deck = () =>
    stackedDeck({ buttonSeat: 0, holes: ['AS AH', 'KS KH', '7D 2C'], board: 'AD KD 9C 4S 3H' });
  const start = (rounds: number) =>
    startHand({
      players: players([1000, 1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10,
      bettingRounds: rounds, deck: deck(),
    });
  const preflop: Step[] = [['p0', call], ['p1', call], ['p2', check]];
  const street: Step[] = [['p1', check], ['p2', check], ['p0', check]];

  it('1 round: showdown right after the pre-flop betting, with the full board dealt', () => {
    const s = play(start(1), preflop);
    expect(s.phase).toBe('complete');
    expect(s.board.map(key)).toEqual(['14D', '13D', '9C', '4S', '3H']);
    expect(s.result!.showdown).toBe(true);
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[0, 30]]);
    expect(s.seats.map((x) => x.stack)).toEqual([1020, 990, 990]);
    expect(totalChips(s)).toBe(3000);
  });

  it('2 rounds: pre-flop and flop betting, then the turn and river are dealt', () => {
    const mid = play(start(2), preflop);
    expect(mid.phase).toBe('flop');
    expect(mid.board).toHaveLength(3);
    const s = play(mid, street);
    expect(s.phase).toBe('complete');
    expect(s.board.map(key)).toEqual(['14D', '13D', '9C', '4S', '3H']);
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[0, 30]]);
  });

  it('3 rounds: betting through the turn', () => {
    let s = play(start(3), preflop);
    s = play(s, street);
    expect(s.phase).toBe('turn');
    expect(s.board).toHaveLength(4);
    s = play(s, street);
    expect(s.phase).toBe('complete');
    expect(s.board).toHaveLength(5);
  });

  it('4 rounds: the standard game', () => {
    let s = play(start(4), preflop);
    for (let i = 0; i < 3; i++) s = play(s, street);
    expect(s.phase).toBe('complete');
    expect(s.board).toHaveLength(5);
  });

  it('an all-in still deals out the board and finishes', () => {
    let s = startHand({
      players: players([100, 100]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, bettingRounds: 2, rng: seededRng(4),
    });
    s = act(s, 'p0', raiseTo(100));
    s = act(s, 'p1', call);
    expect(s.phase).toBe('complete');
    expect(s.board).toHaveLength(5);
    expect(totalChips(s)).toBe(200);
  });
});

describe('wrap-around straights in a real hand', () => {
  function playHand(wrap: boolean): HandState {
    const deck = stackedDeck({ buttonSeat: 0, holes: ['9S 9H', 'KH 4D'], board: 'AD 2C 3S 8H 7D' });
    let s = startHand({
      players: players([1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10,
      wrapAroundStraights: wrap, deck,
    });
    s = play(s, [['p0', call], ['p1', check]]);
    for (let i = 0; i < 3; i++) s = play(s, [['p1', check], ['p0', check]]);
    return s;
  }

  it('turns K-A-2-3-4 into the winning hand only when the rule is on', () => {
    const on = playHand(true);
    expect(on.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[1, 20]]);
    expect(on.result!.winners[0]!.rank!.category).toBe(4);

    const off = playHand(false);
    expect(off.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[0, 20]]);
    expect(off.result!.winners[0]!.rank!.category).toBe(1);
  });
});

describe('rule validation', () => {
  const base = { players: players([1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10 };

  it.each([
    { smallBlind: 2.5 },
    { bigBlind: 10.5 },
    { smallBlind: 20 },
    { minRaise: 0 },
    { minRaise: 2.5 },
    { bettingRounds: 0 },
    { bettingRounds: 5 },
    { bettingRounds: 2.5 },
  ])('rejects %j', (bad) => {
    expect(() => startHand({ ...base, ...bad })).toThrow();
  });
});

describe('any rules, random play', () => {
  it('conserves chips and always finishes the hand', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.array(fc.integer({ min: 1, max: 300 }), { minLength: 2, maxLength: 6 }),
        fc.integer({ min: 1, max: 60 }),  // big blind
        fc.integer({ min: 1, max: 100 }), // minimum raise
        fc.integer({ min: 1, max: 4 }),   // betting rounds
        fc.boolean(),                     // wrap-around straights
        fc.array(fc.nat(1000), { minLength: 800, maxLength: 800 }),
        (seed, stacks, bigBlind, minRaise, rounds, wrap, choices) => {
          const n = stacks.length;
          const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
          let state = startHand({
            players: players(stacks), buttonSeat: seed % n, smallBlind, bigBlind, minRaise,
            bettingRounds: rounds, wrapAroundStraights: wrap, rng: seededRng(seed),
          });
          const total = stacks.reduce((a, b) => a + b, 0);
          expect(totalChips(state)).toBe(total);

          let i = 0;
          while (state.phase !== 'complete') {
            expect(state.toAct).not.toBeNull();
            if (i + 1 >= choices.length) return;
            const seat = state.toAct!;
            const r = applyAction(
              state, state.seats[seat]!.playerId, pickAction(state, choices[i]!, choices[i + 1]!),
            );
            i += 2;
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            state = r.state;
            expect(totalChips(state)).toBe(total);
          }
          if (state.result!.showdown) expect(state.board).toHaveLength(5);
        },
      ),
      { numRuns: 200 },
    );
  });
});