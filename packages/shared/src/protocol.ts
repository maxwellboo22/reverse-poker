import { z } from 'zod';
import type { ClientAction } from './actions';
import type { ChatSendSchema } from './chat';
import type { ChatMessage, ChatReply, RuleView } from './chat';
import type { TableView } from './views';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const ROOM_CODE_LENGTH = 5;
export const MAX_PLAYERS = 6;
export const MAX_CHIPS = 1_000_000;

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
export const SetChipsSchema = z.object({
  playerId: z.string().min(1).max(64),
  chips: z.number().int().min(0).max(MAX_CHIPS),
});
export const KickSchema = z.object({
  playerId: z.string().min(1).max(64),
});

/** The rules the host can change. They apply from the next hand. */
export const SettingsSchema = z.object({
  smallBlind: z.number().int().min(1).max(MAX_CHIPS),
  bigBlind: z.number().int().min(1).max(MAX_CHIPS),
  /** Smallest raise increment at the start of every betting round. */
  minRaise: z.number().int().min(1).max(MAX_CHIPS),
  /** 1 = pre-flop only ... 4 = pre-flop, flop, turn and river. */
  bettingRounds: z.number().int().min(1).max(4),
  wrapAroundStraights: z.boolean(),
});
export type RoomSettings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: RoomSettings = {
  smallBlind: 5,
  bigBlind: 10,
  minRaise: 10,
  bettingRounds: 4,
  wrapAroundStraights: false,
};

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
  settings: RoomSettings;
  houseRules: RuleView[];
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
  'room:leave': (ack: (res: Ack) => void) => void;
  'game:start': (ack: (res: Ack) => void) => void;
  'game:reset': (ack: (res: Ack) => void) => void;
  'game:action': (payload: ClientAction, ack: (res: Ack) => void) => void;
  'chat:send': (
    payload: z.input<typeof ChatSendSchema>,
    ack: (res: Ack<{ reply?: ChatReply }>) => void,
  ) => void;
  'host:setChips': (
    payload: z.input<typeof SetChipsSchema>,
    ack: (res: Ack) => void,
  ) => void;
  'host:setSettings': (
    payload: z.input<typeof SettingsSchema>,
    ack: (res: Ack) => void,
  ) => void;
  'host:kick': (
    payload: z.input<typeof KickSchema>,
    ack: (res: Ack) => void,
  ) => void;
}

export interface ServerToClientEvents {
  'room:lobby': (view: LobbyView) => void;
  'table:view': (view: TableView) => void;
  'table:clear': () => void;
  'room:kicked': () => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:history': (messages: ChatMessage[]) => void;
}