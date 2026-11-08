import { describe, it, expect } from 'vitest';
import { MAX_CHIPS } from '@reverse-poker/shared';
import { Room, STARTING_CHIPS, type RoomPlayer } from './game/room';

function add(room: Room, name: string): RoomPlayer {
  const r = room.addPlayer(name);
  if (!r.ok) throw new Error(r.error);
  return r.player;
}

describe('leaving', () => {
  it('removes the player and passes host to a connected player', () => {
    const room = new Room('TESTA');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    const cara = add(room, 'Cara');
    alice.socketId = null;
    bob.socketId = null;
    cara.socketId = 'socket-cara'; // the only one who is online

    expect(room.hostId).toBe(alice.playerId);
    expect(room.removePlayer(alice.playerId)).toBe(true);
    expect(room.players.has(alice.playerId)).toBe(false);
    expect(room.hostId).toBe(cara.playerId);
  });

    it("refunds a leaver's bet from the current round and finishes the hand", () => {
    const room = new Room('TESTB');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    const cara = add(room, 'Cara');
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    expect(room.hand!.toAct).toBe(0); // Alice

    expect(room.removePlayer(bob.playerId)).toBe(true); // Bob is the small blind: his 5 comes back
    expect(room.handInProgress).toBe(true);
    expect(room.hand!.seats[1]!.status).toBe('folded');
    expect(room.hand!.pots.reduce((sum, p) => sum + p.amount, 0)).toBe(10);
    expect(room.hand!.toAct).toBe(0);

    expect(room.removePlayer(alice.playerId)).toBe(true); // Alice leaves on her turn
    expect(room.handInProgress).toBe(false);
    expect(room.hostId).toBe(cara.playerId);
    expect(cara.chips).toBe(STARTING_CHIPS); // her big blind comes back, nothing more
  });

  it('reports false for someone who is not in the room', () => {
    const room = new Room('TESTC');
    add(room, 'Alice');
    expect(room.removePlayer('ghost')).toBe(false);
  });
});

describe('reset lobby', () => {
  it('is host-only, restores chips and clears the hand', () => {
    const room = new Room('TESTD');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    expect(room.act(alice.playerId, { type: 'fold' })).toEqual({ ok: true });
    expect([alice.chips, bob.chips]).toEqual([995, 1005]);

    expect(room.resetLobby(bob.playerId)).toEqual({ ok: false, error: 'not_host' });
    expect(room.resetLobby(alice.playerId)).toEqual({ ok: true });
    expect(room.hand).toBeNull();
    expect(room.handInProgress).toBe(false);
    expect([alice.chips, bob.chips]).toEqual([STARTING_CHIPS, STARTING_CHIPS]);
  });
});

describe('set chips', () => {
  it('is host-only and only works between hands', () => {
    const room = new Room('TESTE');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');

    expect(room.setChips(bob.playerId, alice.playerId, 5)).toEqual({ ok: false, error: 'not_host' });
    expect(room.setChips(alice.playerId, 'ghost', 5)).toEqual({ ok: false, error: 'no_such_player' });
    expect(room.setChips(alice.playerId, bob.playerId, 250)).toEqual({ ok: true });
    expect(bob.chips).toBe(250);

    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    expect(room.setChips(alice.playerId, bob.playerId, 500)).toEqual({ ok: false, error: 'hand_in_progress' });
    expect(bob.chips).toBe(250);
  });

  it('rejects amounts that are not whole numbers in range', () => {
    const room = new Room('TESTF');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    for (const bad of [-1, 1.5, MAX_CHIPS + 1, Number.NaN]) {
      expect(room.setChips(alice.playerId, bob.playerId, bad)).toEqual({ ok: false, error: 'bad_request' });
    }
    expect(bob.chips).toBe(STARTING_CHIPS);
  });

  it('a player set to 0 chips is not dealt in', () => {
    const room = new Room('TESTG');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    expect(room.setChips(alice.playerId, bob.playerId, 0)).toEqual({ ok: true });
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: false, error: 'not_enough_players' });
  });
});