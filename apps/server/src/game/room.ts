import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  MAX_PLAYERS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH,
  type Ack, type ClientAction, type LobbyView, type TableView,
} from '@reverse-poker/shared';
import { applyAction, startHand, toTableView, type HandState } from '@reverse-poker/poker-engine';

export const STARTING_CHIPS = 1000;
export const SMALL_BLIND = 5;
export const BIG_BLIND = 10;

export interface RoomPlayer {
  playerId: string;
  name: string;
  token: string;          // SECRET: only ever sent to this player, once
  chips: number;
  socketId: string | null; // null = disconnected
}

export class Room {
  readonly code: string;
  hostId: string | null = null;
  readonly players = new Map<string, RoomPlayer>(); // insertion order = seat order
  hand: HandState | null = null;
  private handsPlayed = 0;

  constructor(code: string) {
    this.code = code;
  }

  get handInProgress(): boolean {
    return this.hand !== null && this.hand.phase !== 'complete';
  }

  isConnected(playerId: string): boolean {
    return this.players.get(playerId)?.socketId != null;
  }

  hasConnectedPlayers(): boolean {
    return [...this.players.values()].some((p) => p.socketId !== null);
  }

  addPlayer(name: string): Ack<{ player: RoomPlayer }> {
    if (this.handInProgress) return { ok: false, error: 'game_in_progress' };
    if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'room_full' };
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return { ok: false, error: 'name_taken' };

    const player: RoomPlayer = {
      playerId: randomUUID(),
      name,
      token: randomBytes(32).toString('hex'),
      chips: STARTING_CHIPS,
      socketId: null,
    };
    this.players.set(player.playerId, player);
    this.hostId ??= player.playerId;
    return { ok: true, player };
  }

  /** Checks a reconnect token in constant time. */
  authenticate(playerId: string, token: string): RoomPlayer | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    const a = Buffer.from(player.token);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return player;
  }

  startNextHand(playerId: string): Ack {
    if (playerId !== this.hostId) return { ok: false, error: 'not_host' };
    if (this.handInProgress) return { ok: false, error: 'hand_in_progress' };

    const seated = [...this.players.values()].filter((p) => p.chips > 0);
    if (seated.length < 2) return { ok: false, error: 'not_enough_players' };

    this.hand = startHand({
      players: seated.map((p) => ({ playerId: p.playerId, name: p.name, stack: p.chips })),
      buttonSeat: this.handsPlayed % seated.length, // simple rotation for the MVP
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
    });
    this.handsPlayed += 1;
    this.syncChips(); // a hand can finish instantly if blinds put someone all-in
    return { ok: true };
  }

  act(playerId: string, action: ClientAction): Ack {
    if (!this.hand) return { ok: false, error: 'no_hand' };
    const result = applyAction(this.hand, playerId, action);
    if (!result.ok) return { ok: false, error: result.error };
    this.hand = result.state;
    this.syncChips();
    return { ok: true };
  }

  /** null if this player isn't part of the current hand. */
  tableViewFor(playerId: string): TableView | null {
    const hand = this.hand;
    if (!hand || !hand.seats.some((s) => s.playerId === playerId)) return null;
    return toTableView(hand, playerId, {
      roomCode: this.code,
      isConnected: (id) => this.isConnected(id),
    });
  }

  /** Allowlisted: tokens and socket ids never appear here. */
  lobbyViewFor(playerId: string): LobbyView {
    return {
      code: this.code,
      you: playerId,
      hostId: this.hostId ?? '',
      handInProgress: this.handInProgress,
      players: [...this.players.values()].map((p) => ({
        playerId: p.playerId,
        name: p.name,
        chips: p.chips,
        connected: p.socketId !== null,
      })),
    };
  }

  private syncChips(): void {
    if (!this.hand || this.hand.phase !== 'complete') return;
    for (const seat of this.hand.seats) {
      const p = this.players.get(seat.playerId);
      if (p) p.chips = seat.stack;
    }
  }
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET.charAt(randomInt(ROOM_CODE_ALPHABET.length));
  }
  return code;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  create(): Room {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = randomCode();
      if (!this.rooms.has(code)) {
        const room = new Room(code);
        this.rooms.set(code, room);
        return room;
      }
    }
    throw new Error('could not allocate a room code');
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }
}