import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { ClientAction } from '@reverse-poker/shared';
import { computeLegalActions } from './betting';
import { applyAction, forceFold, startHand, totalChips } from './hand';
import { pickAction } from './random-play';
import { seededRng } from './test-utils';
import type { HandState } from './types';

const players = (stacks: number[]) =>
  stacks.map((stack, i) => ({ playerId: `p${i}`, name: `P${i}`, stack }));

const check: ClientAction = { type: 'check' };
const call: ClientAction = { type: 'call' };
const raiseTo = (amount: number): ClientAction => ({ type: 'raise', amount });

function start3(): HandState {
  return startHand({
    players: players([1000, 1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, rng: seededRng(7),
  });
}

function act(state: HandState, playerId: string, action: ClientAction): HandState {
  const r = applyAction(state, playerId, action);
  if (!r.ok) throw new Error(`${playerId} ${action.type} rejected: ${r.error}`);
  return r.state;
}

function leave(state: HandState, id: string): HandState {
  const r = forceFold(state, id);
  if (!r.ok) throw new Error(`forceFold rejected: ${r.error}`);
  return r.state;
}

const potTotal = (s: HandState) => s.pots.reduce((sum, p) => sum + p.amount, 0);

describe('forceFold basics', () => {
  it('folds a player who is not on turn, returns their blind, and keeps the turn', () => {
    const s = leave(start3(), 'p1'); // small blind
    expect(s.seats[1]!.status).toBe('folded');
    expect(s.seats[1]!.stack).toBe(1000); // their 5 came back
    expect(potTotal(s)).toBe(10);
    expect(s.toAct).toBe(0);
    expect(s.phase).toBe('preflop');
    expect(totalChips(s)).toBe(3000);
  });

  it('passes the turn on when the player on turn leaves', () => {
    const s = leave(start3(), 'p0');
    expect(s.seats[0]!.status).toBe('folded');
    expect(s.toAct).toBe(1);
  });

  it('ends the hand when everyone else has left', () => {
    const s = leave(leave(start3(), 'p1'), 'p0');
    expect(s.phase).toBe('complete');
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[2, 10]]);
    expect(s.result!.refunds).toEqual([]);
    expect(s.seats.map((x) => x.stack)).toEqual([1000, 1000, 1000]);
    expect(totalChips(s)).toBe(3000);
  });

  it('does nothing for a player who has already folded', () => {
    const once = leave(start3(), 'p1');
    const twice = leave(once, 'p1');
    expect(twice.version).toBe(once.version);
    expect(twice).toEqual(once);
  });

  it('rejects unknown players and finished hands', () => {
    expect(forceFold(start3(), 'nobody')).toEqual({ ok: false, error: 'not_seated' });
    const done = leave(leave(start3(), 'p1'), 'p0');
    expect(forceFold(done, 'p2')).toEqual({ ok: false, error: 'hand_over' });
  });
});

describe("a leaver's bet this round is reversed", () => {
  it('undoes a flop bet and the call it received; earlier chips stay in the pot', () => {
    let s = start3();
    s = act(s, 'p0', call);
    s = act(s, 'p1', call);
    s = act(s, 'p2', check);
    expect(s.phase).toBe('flop');
    expect(s.toAct).toBe(1);

    s = act(s, 'p1', raiseTo(100));
    s = act(s, 'p2', call);
    expect(s.toAct).toBe(0); // p0 is being asked to respond
    expect(potTotal(s)).toBe(230);

    s = leave(s, 'p1'); // the bettor leaves

    expect(s.phase).toBe('flop');
    expect(s.currentBet).toBe(0);
    expect(potTotal(s)).toBe(30); // only the pre-flop chips remain
    expect(s.seats.map((x) => x.stack)).toEqual([990, 990, 990]);
    expect(s.seats[1]!.status).toBe('folded');
    expect(s.toAct).toBe(2);
    expect(computeLegalActions(s, 2)).toMatchObject({ canCheck: true, canCall: false });
    expect(totalChips(s)).toBe(3000);

    // Nobody owes anything: two checks finish the round.
    s = act(s, 'p2', check);
    s = act(s, 'p0', check);
    expect(s.phase).toBe('turn');
  });

  it('puts the blinds back after a pre-flop raise is undone', () => {
    let s = start3();
    s = act(s, 'p0', raiseTo(100));
    s = act(s, 'p1', call);
    expect(s.toAct).toBe(2);

    s = leave(s, 'p0');

    expect(s.currentBet).toBe(10);
    expect(s.seats.map((x) => x.stack)).toEqual([1000, 995, 990]);
    expect(potTotal(s)).toBe(15);
    expect(s.toAct).toBe(1);
    expect(computeLegalActions(s, 1)).toMatchObject({ callAmount: 5, canCheck: false });
    expect(totalChips(s)).toBe(3000);
  });

  it('heads-up: the other player simply wins the blinds', () => {
    let s = startHand({
      players: players([1000, 1000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, rng: seededRng(3),
    });
    s = act(s, 'p0', raiseTo(100));
    s = leave(s, 'p0');

    expect(s.phase).toBe('complete');
    expect(s.result!.winners.map((w) => [w.seat, w.amount])).toEqual([[1, 10]]);
    expect(s.result!.refunds).toEqual([]);
    expect(s.seats.map((x) => x.stack)).toEqual([1000, 1000]);
  });

  it('puts an all-in caller back in play when the bet they called is undone', () => {
    let s = startHand({
      players: players([300, 2000, 2000, 2000]), buttonSeat: 0, smallBlind: 5, bigBlind: 10, rng: seededRng(9),
    });
    expect(s.toAct).toBe(3);
    s = act(s, 'p3', raiseTo(1000));
    s = act(s, 'p0', call); // all-in for 300
    expect(s.seats[0]!.status).toBe('allIn');
    expect(s.toAct).toBe(1);

    s = leave(s, 'p3');

    expect(s.seats[0]).toMatchObject({ status: 'active', stack: 300 });
    expect(s.seats[3]).toMatchObject({ status: 'folded', stack: 2000 });
    expect(s.currentBet).toBe(10);
    expect(potTotal(s)).toBe(15);
    expect(s.toAct).toBe(0);
    expect(totalChips(s)).toBe(6300);
  });

  it("does not undo someone else's bet when a different player leaves", () => {
    let s = start3();
    s = act(s, 'p0', raiseTo(100));
    s = leave(s, 'p1'); // the small blind leaves; p0's raise stands

    expect(s.currentBet).toBe(100);
    expect(s.seats[1]!.stack).toBe(1000);
    expect(potTotal(s)).toBe(110);
    expect(s.toAct).toBe(2);
    expect(computeLegalActions(s, 2)!.callAmount).toBe(90);
    expect(totalChips(s)).toBe(3000);
  });

  it('lowers the bet when the big blind leaves', () => {
    const s = leave(start3(), 'p2');
    expect(s.seats[2]!.stack).toBe(1000);
    expect(s.currentBet).toBe(5);
    expect(potTotal(s)).toBe(5);
    expect(s.toAct).toBe(0);
    expect(totalChips(s)).toBe(3000);
  });
});

describe('forceFold properties', () => {
  it('people leaving at random never breaks chips or the turn order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.array(fc.integer({ min: 1, max: 300 }), { minLength: 2, maxLength: 6 }),
        fc.array(fc.nat(1000), { minLength: 900, maxLength: 900 }),
        (seed, stacks, choices) => {
          const n = stacks.length;
          let state = startHand({
            players: players(stacks), buttonSeat: seed % n, smallBlind: 5, bigBlind: 10, rng: seededRng(seed),
          });
          const total = totalChips(state);

          let i = 0;
          while (state.phase !== 'complete') {
            if (i + 2 >= choices.length) return;
            expect(state.toAct).not.toBeNull();
            const leaves = choices[i]! % 5 === 0; // about one step in five is someone leaving
            const r = leaves
              ? forceFold(state, state.seats[choices[i + 1]! % n]!.playerId)
              : applyAction(
                  state,
                  state.seats[state.toAct!]!.playerId,
                  pickAction(state, choices[i + 1]!, choices[i + 2]!),
                );
            i += 3;
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            state = r.state;
            expect(totalChips(state)).toBe(total);
            if (state.phase !== 'complete') {
              expect(potTotal(state)).toBe(state.seats.reduce((sum, x) => sum + x.committedThisHand, 0));
            }
          }

          const result = state.result!;
          const paid =
            result.winners.reduce((sum, w) => sum + w.amount, 0) +
            result.refunds.reduce((sum, r) => sum + r.amount, 0);
          expect(paid).toBe(state.seats.reduce((sum, x) => sum + x.committedThisHand, 0));
        },
      ),
      { numRuns: 300 },
    );
  });
});