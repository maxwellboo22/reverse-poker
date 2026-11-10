import { describe, it, expect } from 'vitest';
import { MAX_PLAYERS } from '@reverse-poker/shared';
import { Room } from './game/room';

describe('room capacity', () => {
  it('holds ten players and refuses the eleventh', () => {
    expect(MAX_PLAYERS).toBe(10);
    const room = new Room('CAPAC');
    for (let i = 0; i < 10; i++) expect(room.addPlayer(`Player${i}`).ok).toBe(true);
    expect(room.addPlayer('Extra')).toEqual({ ok: false, error: 'room_full' });
  });

  it('starts a hand with a full table', () => {
    const room = new Room('CAPAD');
    for (let i = 0; i < 10; i++) room.addPlayer(`Player${i}`);
    expect(room.startNextHand(room.hostId!)).toEqual({ ok: true });
    expect(room.hand!.seats).toHaveLength(10);
    expect(room.hand!.toAct).not.toBeNull();
  });
});