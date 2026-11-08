import { z } from 'zod';
import type { ClientAction } from './actions';
import type { TableView } from './views';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const ROOM_CODE_LENGTH = 5;
export const MAX_PLAYERS = 6;

// Normalise first (trim, uppercase), then validate.
const nameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(20).regex(/^[^\p{C}]+$/u));

const codeSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/));

export const CreateRoomSchema = z.object({ name: nameSchema });
export const JoinRoomSchema = z.object({ code: codeSchema, name: nameSchema });
export const ResumeSchema = z.object({
  code: codeSchema,
  playerId: z.string().min(1).max(64),
  token: z.string().min(1).max(128),
});

/** Result of a request. Errors are short codes the UI can map to messages. */
export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Secret credentials the server gives a player so they can reconnect. */
export interface Session {
  code: string;
  playerId: string;
  token: string;
}

export interface LobbyPlayer {
  playerId: string;
  name: string;
  chips: number;
  connected: boolean;
}

export interface LobbyView {
  code: string;
  you: string;
  hostId: string;
  handInProgress: boolean;
  players: LobbyPlayer[];
}

export interface ClientToServerEvents {
  'room:create': (
    payload: z.input<typeof CreateRoomSchema>,
    ack: (res: Ack<{ session: Session }>) => void,
  ) => void;
  'room:join': (
    payload: z.input<typeof JoinRoomSchema>,
    ack: (res: Ack<{ session: Session }>) => void,
  ) => void;
  'room:resume': (
    payload: z.input<typeof ResumeSchema>,
    ack: (res: Ack<{ session: Session }>) => void,
  ) => void;
  'game:start': (ack: (res: Ack) => void) => void;
  'game:action': (payload: ClientAction, ack: (res: Ack) => void) => void;
}

export interface ServerToClientEvents {
  'room:lobby': (view: LobbyView) => void;
  'table:view': (view: TableView) => void;
}