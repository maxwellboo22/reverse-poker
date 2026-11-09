import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';
import {
  ChatSendSchema, ClientActionSchema, CreateRoomSchema, JoinRoomSchema, KickSchema, ResumeSchema,
  SetChipsSchema,
  type Ack, type ChatReply, type ClientToServerEvents, type ServerToClientEvents,
} from '@reverse-poker/shared';
import { RoomManager, type Room, type RoomPlayer } from '../game/room';

type NoEvents = Record<string, never>;

interface SocketData {
  roomCode?: string;
  playerId?: string;
  failedAttempts: number;
  chatTimes: number[];
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, NoEvents, SocketData>;

const ROOM_IDLE_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_PER_WINDOW = 6;

export interface GameServerOptions {
  port: number; // 0 = pick a free port (used by tests)
  clientOrigin?: string | string[];
}

export interface GameServer {
  port: number;
  rooms: RoomManager;
  close(): Promise<void>;
}

/** Clients may omit the ack callback; never assume it exists. */
function respond<T extends object>(ack: ((res: Ack<T>) => void) | undefined, result: Ack<T>): void {
  if (typeof ack === 'function') ack(result);
}

export async function startGameServer(opts: GameServerOptions): Promise<GameServer> {
  const rooms = new RoomManager();

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io = new Server<ClientToServerEvents, ServerToClientEvents, NoEvents, SocketData>(httpServer, {
    cors: { origin: opts.clientOrigin ?? 'http://localhost:5173' },
    maxHttpBufferSize: 16 * 1024, // our messages are tiny; refuse big ones
  });

  const cleanupTimers = new Map<string, NodeJS.Timeout>();

  /**
   * THE ONLY place game state leaves the server. Each player gets their own
   * personalised view. Never use io.to(room).emit() for table state.
   * Chat messages are public, but they go out the same way.
   */
  function broadcast(room: Room): void {
    const pending = room.takePendingChat();
    for (const player of room.players.values()) {
      if (!player.socketId) continue;
      const socket = io.sockets.sockets.get(player.socketId);
      if (!socket) continue;
      socket.emit('room:lobby', room.lobbyViewFor(player.playerId));
      const view = room.tableViewFor(player.playerId);
      if (view) socket.emit('table:view', view);
      for (const message of pending) socket.emit('chat:message', message);
    }
  }

  /** Tells every connected player to drop whatever table they are showing. */
  function clearTables(room: Room): void {
    for (const player of room.players.values()) {
      if (player.socketId) io.sockets.sockets.get(player.socketId)?.emit('table:clear');
    }
  }

  /** Cuts a removed player's connection off from the room and tells them why. */
  function evict(socketId: string | null): void {
    if (!socketId) return;
    const kicked = io.sockets.sockets.get(socketId);
    if (!kicked) return;
    kicked.data.roomCode = undefined;
    kicked.data.playerId = undefined;
    kicked.emit('room:kicked');
  }

  function attach(socket: GameSocket, room: Room, player: RoomPlayer): void {
    // One live connection per player: a newer one replaces an older one.
    if (player.socketId && player.socketId !== socket.id) {
      io.sockets.sockets.get(player.socketId)?.disconnect(true);
    }
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.playerId;
    const timer = cleanupTimers.get(room.code);
    if (timer) {
      clearTimeout(timer);
      cleanupTimers.delete(room.code);
    }
    socket.emit('chat:history', room.getChatHistory());
  }

  /** Identity comes from the server-side binding, never from the message. */
  function current(socket: GameSocket): { room: Room; playerId: string } | null {
    const { roomCode, playerId } = socket.data;
    if (!roomCode || !playerId) return null;
    const room = rooms.get(roomCode);
    const player = room?.players.get(playerId);
    if (!room || !player || player.socketId !== socket.id) return null;
    return { room, playerId };
  }

  function noteFailure(socket: GameSocket): void {
    socket.data.failedAttempts += 1;
    if (socket.data.failedAttempts >= MAX_FAILED_ATTEMPTS) socket.disconnect(true);
  }

  function scheduleCleanup(room: Room): void {
    if (room.hasConnectedPlayers()) return;
    clearTimeout(cleanupTimers.get(room.code));
    const timer = setTimeout(() => {
      cleanupTimers.delete(room.code);
      if (!room.hasConnectedPlayers()) rooms.delete(room.code);
    }, ROOM_IDLE_MS);
    timer.unref();
    cleanupTimers.set(room.code, timer);
  }

  io.on('connection', (socket) => {
    socket.data.failedAttempts = 0;
    socket.data.chatTimes = [];

    socket.on('room:create', (raw, ack) => {
      if (socket.data.playerId) return respond(ack, { ok: false, error: 'already_in_room' });
      const parsed = CreateRoomSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });

      const room = rooms.create();
      const added = room.addPlayer(parsed.data.name);
      if (!added.ok) return respond(ack, added);
      attach(socket, room, added.player);
      respond(ack, {
        ok: true,
        session: { code: room.code, playerId: added.player.playerId, token: added.player.token },
      });
      broadcast(room);
    });

    socket.on('room:join', (raw, ack) => {
      if (socket.data.playerId) return respond(ack, { ok: false, error: 'already_in_room' });
      const parsed = JoinRoomSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });

      const room = rooms.get(parsed.data.code);
      if (!room) {
        noteFailure(socket);
        return respond(ack, { ok: false, error: 'room_not_found' });
      }
      const added = room.addPlayer(parsed.data.name);
      if (!added.ok) return respond(ack, added);
      attach(socket, room, added.player);
      respond(ack, {
        ok: true,
        session: { code: room.code, playerId: added.player.playerId, token: added.player.token },
      });
      broadcast(room);
    });

    socket.on('room:resume', (raw, ack) => {
      if (socket.data.playerId) return respond(ack, { ok: false, error: 'already_in_room' });
      const parsed = ResumeSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });

      const room = rooms.get(parsed.data.code);
      const player = room?.authenticate(parsed.data.playerId, parsed.data.token);
      if (!room || !player) {
        noteFailure(socket);
        return respond(ack, { ok: false, error: 'bad_session' });
      }
      attach(socket, room, player);
      respond(ack, {
        ok: true,
        session: { code: room.code, playerId: player.playerId, token: player.token },
      });
      broadcast(room); // sends this player a fresh personalised snapshot
    });

    socket.on('room:leave', (ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const { room, playerId } = cur;

      room.removePlayer(playerId); // folds them first if a hand is running
      socket.data.roomCode = undefined;
      socket.data.playerId = undefined;
      respond(ack, { ok: true });

      if (room.players.size === 0) {
        clearTimeout(cleanupTimers.get(room.code));
        cleanupTimers.delete(room.code);
        rooms.delete(room.code);
      } else {
        broadcast(room);
        scheduleCleanup(room);
      }
    });

    socket.on('game:start', (ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const result = cur.room.startNextHand(cur.playerId);
      respond(ack, result);
      if (result.ok) broadcast(cur.room);
    });

    socket.on('game:reset', (ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const result = cur.room.resetLobby(cur.playerId);
      respond(ack, result);
      if (result.ok) {
        clearTables(cur.room);
        broadcast(cur.room);
      }
    });

    socket.on('chat:send', (raw, ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });

      // At most a handful of messages per few seconds per connection.
      const now = Date.now();
      const recent = socket.data.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
      if (recent.length >= CHAT_MAX_PER_WINDOW) {
        socket.data.chatTimes = recent;
        return respond(ack, { ok: false, error: 'rate_limited' });
      }
      recent.push(now);
      socket.data.chatTimes = recent;

      const parsed = ChatSendSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });

      const outcome = cur.room.handleChat(cur.playerId, parsed.data.text);
      if (outcome.kicked) evict(outcome.kicked.socketId);
      if (outcome.tablesCleared) clearTables(cur.room);
      respond<{ reply?: ChatReply }>(ack, { ok: true, reply: outcome.reply });
      broadcast(cur.room);
    });

    socket.on('host:setChips', (raw, ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const parsed = SetChipsSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });
      const result = cur.room.setChips(cur.playerId, parsed.data.playerId, parsed.data.chips);
      respond(ack, result);
      if (result.ok) broadcast(cur.room);
    });

    socket.on('host:setSettings', (raw, ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const result = cur.room.setSettings(cur.playerId, raw);
      respond(ack, result);
      if (result.ok) broadcast(cur.room);
    });

    socket.on('host:kick', (raw, ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const parsed = KickSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });

      const result = cur.room.kick(cur.playerId, parsed.data.playerId);
      if (!result.ok) return respond(ack, result);
      evict(result.socketId);
      respond(ack, { ok: true });
      broadcast(cur.room); // the kicked player is already gone from the room, so they get nothing
    });

    socket.on('game:action', (raw, ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const parsed = ClientActionSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });
      const result = cur.room.act(cur.playerId, parsed.data);
      respond(ack, result);
      if (result.ok) broadcast(cur.room);
    });

    socket.on('disconnect', () => {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;
      const room = rooms.get(roomCode);
      const player = room?.players.get(playerId);
      // Ignore stale sockets that were already replaced by a newer connection.
      if (!room || !player || player.socketId !== socket.id) return;
      player.socketId = null;
      broadcast(room);
      scheduleCleanup(room);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    rooms,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of cleanupTimers.values()) clearTimeout(timer);
        io.close(() => resolve());
      }),
  };
}