import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { ClientAction } from '@reverse-poker/shared';
import { computeLegalActions } from './betting';
import { applyAction, startHand, totalChips } from './hand';
import { pickAction } from './random-play';
import type { HandState } from './types';
import { seededRng, stackedDeck } from './test-utils';

const makePlayers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, name: `P${i}`, stack: 1000 }));

const key = (c: { rank: number; suit: string }) => `${c.rank}${c.suit}`;

function act(state: HandState, playerId: string, action: ClientAction): HandState {
  const r = applyAction(state, playerId, action);
  if (!r.ok) throw new Error(`${playerId} ${action.type} rejected: ${r.error}`);
  return r.state;
}

function play(state: HandState, steps: [string, ClientAction][]): HandState {
  return steps.reduce((st, [who, a]) => act(st, who, a), state);
}

const check: ClientAction = { type: 'check' };
const call: ClientAction = { type: 'call' };
const fold: ClientAction = { type: 'fold' };

function start3() {
  return startHand({
    players: makePlayers(3), buttonSeat: 0, smallBlind: 5, bigBlind: 10, rng: seededRng(7),
  });
}

describe('startHand', () => {
  it('posts blinds, deals two cards each, sets first to act', () => {
    const s = start3();
    expect(s.seats.map((x) => x.stack)).toEqual([1000, 995, 990]);
    expect(s.pots[0]!.amount).toBe(15);
    expect(s.currentBet).toBe(10);
    expect(s.toAct).toBe(0); // left of the big blind
    expect(s.phase).toBe('preflop');

    const all = [...s.deck, ...s.seats.flatMap((x) => x.holeCards!)];
    expect(s.deck).toHaveLength(46);
    expect(new Set(all.map(key)).size).toBe(52);
  });

  it('heads-up: button is small blind and acts first, other seat acts first after the flop', () => {
    let s = startHand({ players: makePlayers(2), buttonSeat: 0, smallBlind: 5, bigBlind: 10, rng: seededRng(3) });
    expect(s.seats.map((x) => x.committedThisRound)).toEqual([5, 10]);
    expect(s.toAct).toBe(0);
    s = play(s, [['p0', call], ['p1', check]]);
    expect(s.phase).toBe('flop');
    expect(s.toAct).toBe(1);
  });

  it('rejects stacks that are not a whole number of at least 1', () => {
    for (const bad of [0, -5, 10.5]) {
      const players = makePlayers(3);
      players[1]!.stack = bad;
      expect(() => startHand({ players, buttonSeat: 0, smallBlind: 5, bigBlind: 10 })).toThrow();
    }
  });
});

describe('legal actions', () => {
  it('first to act facing the big blind', () => {
    const s = start3();
    expect(computeLegalActions(s, 0)).toEqual({
      canFold: true, canCheck: false, canCall: true, callAmount: 10,
      canRaise: true, minRaiseTo: 20, maxRaiseTo: 1000,
    });
    expect(computeLegalActions(s, 1)).toBeNull(); // not their turn
  });
});

describe('applyAction validation', () => {
  it('rejects out-of-turn and unknown players', () => {
    const s = start3();
    expect(applyAction(s, 'p1', call)).toEqual({ ok: false, error: 'not_your_turn' });
    expect(applyAction(s, 'nobody', call)).toEqual({ ok: false, error: 'not_seated' });
  });

  it('rejects checking while facing a bet', () => {
    expect(applyAction(start3(), 'p0', check)).toEqual({ ok: false, error: 'illegal_check' });
  });

  it('rejects raises below the minimum or above the maximum', () => {
    const s = start3();
    expect(applyAction(s, 'p0', { type: 'raise', amount: 15 })).toEqual({ ok: false, error: 'illegal_raise' });
    expect(applyAction(s, 'p0', { type: 'raise', amount: 1001 })).toEqual({ ok: false, error: 'illegal_raise' });
    expect(applyAction(s, 'p0', { type: 'raise', amount: 20.5 })).toEqual({ ok: false, error: 'illegal_raise' });
  });

  it('does not mutate the state it was given', () => {
    const s = start3();
    const before = JSON.stringify(s);
    applyAction(s, 'p0', call);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('a raise sets the new minimum raise', () => {
    const s = act(start3(), 'p0', { type: 'raise', amount: 30 });
    expect(s.currentBet).toBe(30);
    expect(s.lastRaiseSize).toBe(20);
    expect(s.toAct).toBe(1);
    expect(computeLegalActions(s, 1)!.minRaiseTo).toBe(50);
  });
});

describe('betting rounds', () => {
  it('gives the big blind the option when everyone limps', () => {
    const s = play(start3(), [['p0', call], ['p1', call]]);
    expect(s.phase).toBe('preflop');
    expect(s.toAct).toBe(2);
    const legal = computeLegalActions(s, 2)!;
    expect(legal.canCheck).toBe(true);
    expect(legal.canRaise).toBe(true);
  });

  it('awards the pot when everyone else folds', () => {
    const s = play(start3(), [['p0', fold], ['p1', fold]]);
    expect(s.phase).toBe('complete');
    expect(s.result).toEqual({ winners: [{ seat: 2, amount: 15, rank: null }], refunds: [], showdown: false });
    expect(s.seats.map((x) => x.stack)).toEqual([1000, 995, 1005]);
    expect(applyAction(s, 'p2', check)).toEqual({ ok: false, error: 'hand_over' });
  });
});

describe('showdown', () => {
  it('plays a full hand to showdown and pays the best hand', () => {
    const deck = stackedDeck({
      buttonSeat: 0,
      holes: ['AS AH', 'KS KH', '7D 2C'],
      board: 'AD KD 9C 4S 3H',
    });
    let s = startHand({ players: makePlayers(3), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    expect(s.seats[0]!.holeCards!.map(key)).toEqual(['14S', '14H']);
    expect(s.seats[2]!.holeCards!.map(key)).toEqual(['7D', '2C']);

    s = play(s, [['p0', call], ['p1', call], ['p2', check]]);
    expect(s.phase).toBe('flop');
    expect(s.board.map(key)).toEqual(['14D', '13D', '9C']);
    expect(s.toAct).toBe(1);

    const street: [string, ClientAction][] = [['p1', check], ['p2', check], ['p0', check]];
    s = play(s, street);
    expect(s.phase).toBe('turn');
    expect(s.board).toHaveLength(4);
    s = play(s, street);
    expect(s.phase).toBe('river');
    expect(s.board).toHaveLength(5);
    s = play(s, street);

    expect(s.phase).toBe('complete');
    expect(s.result!.showdown).toBe(true);
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[0, 30]]);
    expect(s.seats.map((x) => x.stack)).toEqual([1020, 990, 990]);
    expect(totalChips(s)).toBe(3000);
  });

  it('splits a tied pot and gives the odd chip to the first winner left of the button', () => {
    const deck = stackedDeck({
      buttonSeat: 0,
      holes: ['2D 3C', '4D 5C', '6D 7C'],
      board: 'AS KS QS JS TS', // everyone plays the board: seats 0 and 2 tie
    });
    let s = startHand({ players: makePlayers(3), buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck });
    s = play(s, [['p0', { type: 'raise', amount: 25 }], ['p1', fold], ['p2', call]]);
    expect(s.phase).toBe('flop');
    expect(s.toAct).toBe(2); // seat 1 folded

    const street: [string, ClientAction][] = [['p2', check], ['p0', check]];
    s = play(s, street);
    s = play(s, street);
    s = play(s, street);

    expect(s.phase).toBe('complete');
    // pot = 25 + 5 + 25 = 55. Seat 2 is first left of the button among winners: 28 vs 27.
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[2, 28], [0, 27]]);
    expect(s.seats.map((x) => x.stack)).toEqual([1002, 995, 1003]);
    expect(totalChips(s)).toBe(3000);
  });
});

describe('random play', () => {
  it('conserves chips, accepts every legal move, and never duplicates a card', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.nat(1000), { minLength: 400, maxLength: 400 }),
        (seed, n, choices) => {
          let state = startHand({
            players: makePlayers(n), buttonSeat: seed % n, smallBlind: 5, bigBlind: 10, rng: seededRng(seed),
          });
          const total = totalChips(state);
          let i = 0;

          while (state.phase !== 'complete' && i + 1 < choices.length) {
            const seat = state.toAct!;
            const action = pickAction(state, choices[i]!, choices[i + 1]!);
            i += 2;

            const r = applyAction(state, state.seats[seat]!.playerId, action);
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            state = r.state;

            expect(totalChips(state)).toBe(total);
            for (const s of state.seats) expect(s.stack).toBeGreaterThanOrEqual(0);
            const cards = [...state.deck, ...state.board, ...state.seats.flatMap((x) => x.holeCards!)];
            expect(new Set(cards.map(key)).size).toBe(cards.length);
          }
        },
      ),
    );
  });
});