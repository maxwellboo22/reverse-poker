import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type RoomSettings } from '@reverse-poker/shared';
import { Room, STARTING_CHIPS, type RoomPlayer } from './game/room';

function add(room: Room, name: string): RoomPlayer {
  const r = room.addPlayer(name);
  if (!r.ok) throw new Error(r.error);
  return r.player;
}

const custom: RoomSettings = {
  smallBlind: 25, bigBlind: 50, minRaise: 100, bettingRounds: 2, wrapAroundStraights: true,
};

describe('room settings', () => {
  it('starts with the defaults and shows them in the lobby view', () => {
    const room = new Room('SETA1');
    const alice = add(room, 'Alice');
    expect(room.settings).toEqual(DEFAULT_SETTINGS);
    expect(room.lobbyViewFor(alice.playerId).settings).toEqual(DEFAULT_SETTINGS);
  });

  it('only the host can change them', () => {
    const room = new Room('SETB1');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    expect(room.setSettings(bob.playerId, custom)).toEqual({ ok: false, error: 'not_host' });
    expect(room.setSettings(alice.playerId, custom)).toEqual({ ok: true });
    expect(room.settings).toEqual(custom);
  });

  it('rejects invalid settings and keeps the old ones', () => {
    const room = new Room('SETC1');
    const alice = add(room, 'Alice');
    const bad: unknown[] = [
      { ...custom, smallBlind: 0 },
      { ...custom, bigBlind: 10.5 },
      { ...custom, minRaise: 0 },
      { ...custom, bettingRounds: 0 },
      { ...custom, bettingRounds: 5 },
      { ...custom, wrapAroundStraights: 'yes' },
      { smallBlind: 5 },
      null,
      'nonsense',
    ];
    for (const b of bad) {
      expect(room.setSettings(alice.playerId, b)).toEqual({ ok: false, error: 'bad_request' });
    }
    expect(room.setSettings(alice.playerId, { ...custom, smallBlind: 60 })).toEqual({
      ok: false, error: 'blinds_order',
    });
    expect(room.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('the next hand uses the new rules', () => {
    const room = new Room('SETD1');
    const alice = add(room, 'Alice');
    add(room, 'Bob');
    expect(room.setSettings(alice.playerId, custom)).toEqual({ ok: true });
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    const h = room.hand!;
    expect([h.smallBlind, h.bigBlind, h.minRaise, h.bettingRounds, h.wrapAroundStraights]).toEqual([
      25, 50, 100, 2, true,
    ]);
  });

  it('changing the rules mid-hand leaves that hand alone and applies to the next one', () => {
    const room = new Room('SETE1');
    const alice = add(room, 'Alice');
    add(room, 'Bob');
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    expect(room.setSettings(alice.playerId, custom)).toEqual({ ok: true });
    expect(room.hand!.bigBlind).toBe(10);

    expect(room.act(alice.playerId, { type: 'fold' })).toEqual({ ok: true }); // heads-up: Alice acts first
    expect(room.handInProgress).toBe(false);
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    expect(room.hand!.bigBlind).toBe(50);
  });
});

describe('kick', () => {
  it('is host-only, and the host cannot kick themselves', () => {
    const room = new Room('KICKA');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    expect(room.kick(bob.playerId, alice.playerId)).toEqual({ ok: false, error: 'not_host' });
    expect(room.kick(alice.playerId, alice.playerId)).toEqual({ ok: false, error: 'cannot_kick_self' });
    expect(room.kick(alice.playerId, 'ghost')).toEqual({ ok: false, error: 'no_such_player' });
    expect(room.players.size).toBe(2);
  });

  it('removes the player and reports their socket so the server can tell them', () => {
    const room = new Room('KICKB');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    bob.socketId = 'sock-bob';
    expect(room.kick(alice.playerId, bob.playerId)).toEqual({ ok: true, socketId: 'sock-bob' });
    expect(room.players.has(bob.playerId)).toBe(false);
    expect(room.hostId).toBe(alice.playerId);
  });

  it("mid-hand: the kicked player folds and this round's bets are returned", () => {
    const room = new Room('KICKC');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    const cara = add(room, 'Cara');
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });

    expect(room.kick(alice.playerId, bob.playerId)).toEqual({ ok: true, socketId: null }); // small blind
    expect(room.hand!.seats[1]!.status).toBe('folded');
    expect(room.hand!.pots.reduce((sum, p) => sum + p.amount, 0)).toBe(10);
    expect(room.handInProgress).toBe(true);

    expect(room.kick(alice.playerId, cara.playerId)).toEqual({ ok: true, socketId: null }); // big blind
    expect(room.handInProgress).toBe(false);
    expect(cara.chips).toBe(STARTING_CHIPS); // her big blind came back
  });
});