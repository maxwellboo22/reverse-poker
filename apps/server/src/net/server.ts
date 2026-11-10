import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';
import {
  ChatSendSchema, ClientActionSchema, CreateRoomSchema, JoinRoomSchema, KickSchema, ResumeSchema,
  SetChipsSchema,
  type Ack, type ChatReply, type ClientToServerEvents, type ServerToClientEvents,
} from '@reverse-poker/shared';
import { DEFAULT_LIMITS, type Limits } from '../config';
import { RoomManager, type Room, type RoomPlayer } from '../game/room';
import { SlidingWindow, clientIp } from '../limits';
import { errorFields, log } from '../log';

type NoEvents = Record<string, never>;

interface SocketData {
  roomCode?: string;
  playerId?: string;
  ip: string;
  failedAttempts: number;
  strikes: number;
  chatTimes: number[];
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, NoEvents, SocketData>;

const ROOM_IDLE_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;
const MAX_STRIKES = 10;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_PER_WINDOW = 6;

export interface GameServerOptions {
  port: number; // 0 = pick a free port (used by tests)
  host?: string;
  clientOrigin?: string | string[];
  limits?: Partial<Limits>;
  /** How many proxies sit in front of the server. 0 = none (the default). */
  trustProxyHops?: number;
  logClientIps?: boolean;
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
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const hops = opts.trustProxyHops ?? 0;
  const origins = Array.isArray(opts.clientOrigin)
    ? opts.clientOrigin
    : [opts.clientOrigin ?? 'http://localhost:5173'];
  const rooms = new RoomManager();

  const roomCreates = new SlidingWindow(limits.roomCreatesPerIpPerHour, 60 * 60 * 1000);
  const failedJoins = new SlidingWindow(limits.failedJoinsPerIpPer5Min, 5 * 60 * 1000);
  const events = new SlidingWindow(limits.eventsPerSocketPer10s, 10_000);
  let connections = 0;
  const connectionsByIp = new Map<string, number>();

  const pruneTimer = setInterval(() => {
    roomCreates.prune();
    failedJoins.prune();
    events.prune();
  }, 60_000);
  pruneTimer.unref();

  const httpServer = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io = new Server<ClientToServerEvents, ServerToClientEvents, NoEvents, SocketData>(httpServer, {
    cors: { origin: origins },
    maxHttpBufferSize: 16 * 1024, // our messages are tiny; refuse big ones
    // CORS only protects the polling transport. This also stops other websites from opening a
    // WebSocket to us. Requests with no Origin header (scripts, tests) are allowed through.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, origin === undefined || origins.includes(origin));
    },
  });

  const cleanupTimers = new Map<string, NodeJS.Timeout>();

  // Refuse new connections when the server or one address has too many.
  io.use((socket, next) => {
    const ip = clientIp(socket.handshake.headers, socket.handshake.address, hops);
    if (connections >= limits.maxConnections) {
      log('warn', 'connection_refused', { reason: 'server_busy' });
      return next(new Error('server_busy'));
    }
    if ((connectionsByIp.get(ip) ?? 0) >= limits.maxConnectionsPerIp) {
      log('warn', 'connection_refused', { reason: 'too_many_connections', ip });
      return next(new Error('too_many_connections'));
    }
    socket.data.ip = ip;
    next();
  });

  /**
   * THE ONLY place game state leaves the server. Each player gets their own
   * personalised view. Never use io.to(room).emit() for table state.
   * Chat messages are public, but they go out the same way.
   */
  function broadcast(room: Room): void {
    const pending = room.takePendingChat();
    for (const player of room.players.values()) {
      if (!player.socketId) continue;
      try {
        const socket = io.sockets.sockets.get(player.socketId);
        if (!socket) continue;
        socket.emit('room:lobby', room.lobbyViewFor(player.playerId));
        const view = room.tableViewFor(player.playerId);
        if (view) socket.emit('table:view', view);
        for (const message of pending) socket.emit('chat:message', message);
      } catch (e) {
        log('error', 'broadcast_failed', errorFields(e)); // one broken socket must not stop the rest
      }
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

  /**
   * Every handler goes through here: it limits how fast one connection can send messages, and a
   * bug inside a handler becomes an error reply for that one request instead of a server crash.
   */
  function on<E extends keyof ClientToServerEvents>(
    socket: GameSocket,
    event: E,
    handler: ClientToServerEvents[E],
  ): void {
    const wrapped = (...args: unknown[]): void => {
      const last = args[args.length - 1];
      const ack = typeof last === 'function' ? (last as (res: Ack) => void) : undefined;
      try {
        if (!events.allow(socket.id)) {
          socket.data.strikes += 1;
          respond(ack, { ok: false, error: 'rate_limited' });
          if (socket.data.strikes >= MAX_STRIKES) socket.disconnect(true);
          return;
        }
        (handler as unknown as (...a: unknown[]) => void)(...args);
      } catch (e) {
        log('error', 'handler_failed', { event, ...errorFields(e) });
        respond(ack, { ok: false, error: 'server_error' });
      }
    };
    socket.on(event, wrapped as never);
  }

  io.on('connection', (socket) => {
    const ip = socket.data.ip;
    connections += 1;
    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
    socket.data.failedAttempts = 0;
    socket.data.strikes = 0;
    socket.data.chatTimes = [];
    if (opts.logClientIps) log('info', 'connection', { ip });

    on(socket, 'room:create', (raw, ack) => {
      if (socket.data.playerId) return respond(ack, { ok: false, error: 'already_in_room' });
      const parsed = CreateRoomSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });
      if (rooms.size >= limits.maxRooms) {
        log('warn', 'room_cap_reached');
        return respond(ack, { ok: false, error: 'server_full' });
      }
      if (!roomCreates.allow(ip)) return respond(ack, { ok: false, error: 'rate_limited' });

      const room = rooms.create();
      const added = room.addPlayer(parsed.data.name);
      if (!added.ok) {
        rooms.delete(room.code); // never leave an empty room behind
        return respond(ack, added);
      }
      attach(socket, room, added.player);
      respond(ack, {
        ok: true,
        session: { code: room.code, playerId: added.player.playerId, token: added.player.token },
      });
      broadcast(room);
    });

    on(socket, 'room:join', (raw, ack) => {
      if (socket.data.playerId) return respond(ack, { ok: false, error: 'already_in_room' });
      const parsed = JoinRoomSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });
      if (failedJoins.isFull(ip)) return respond(ack, { ok: false, error: 'rate_limited' });

      const room = rooms.get(parsed.data.code);
      if (!room) {
        failedJoins.record(ip);
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

    on(socket, 'room:resume', (raw, ack) => {
      if (socket.data.playerId) return respond(ack, { ok: false, error: 'already_in_room' });
      const parsed = ResumeSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });
      if (failedJoins.isFull(ip)) return respond(ack, { ok: false, error: 'rate_limited' });

      const room = rooms.get(parsed.data.code);
      const player = room?.authenticate(parsed.data.playerId, parsed.data.token);
      if (!room || !player) {
        failedJoins.record(ip);
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

    on(socket, 'room:leave', (ack) => {
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

    on(socket, 'game:start', (ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const result = cur.room.startNextHand(cur.playerId);
      respond(ack, result);
      if (result.ok) broadcast(cur.room);
    });

    on(socket, 'game:reset', (ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const result = cur.room.resetLobby(cur.playerId);
      respond(ack, result);
      if (result.ok) {
        clearTables(cur.room);
        broadcast(cur.room);
      }
    });

    on(socket, 'chat:send', (raw, ack) => {
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

    on(socket, 'host:setChips', (raw, ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const parsed = SetChipsSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });
      const result = cur.room.setChips(cur.playerId, parsed.data.playerId, parsed.data.chips);
      respond(ack, result);
      if (result.ok) broadcast(cur.room);
    });

    on(socket, 'host:setSettings', (raw, ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const result = cur.room.setSettings(cur.playerId, raw);
      respond(ack, result);
      if (result.ok) broadcast(cur.room);
    });

    on(socket, 'host:kick', (raw, ack) => {
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

    on(socket, 'game:action', (raw, ack) => {
      const cur = current(socket);
      if (!cur) return respond(ack, { ok: false, error: 'not_in_room' });
      const parsed = ClientActionSchema.safeParse(raw);
      if (!parsed.success) return respond(ack, { ok: false, error: 'bad_request' });
      const result = cur.room.act(cur.playerId, parsed.data);
      respond(ack, result);
      if (result.ok) broadcast(cur.room);
    });

    socket.on('disconnect', () => {
      connections = Math.max(0, connections - 1);
      const left = (connectionsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) connectionsByIp.delete(ip);
      else connectionsByIp.set(ip, left);
      events.forget(socket.id);

      try {
        const { roomCode, playerId } = socket.data;
        if (!roomCode || !playerId) return;
        const room = rooms.get(roomCode);
        const player = room?.players.get(playerId);
        // Ignore stale sockets that were already replaced by a newer connection.
        if (!room || !player || player.socketId !== socket.id) return;
        player.socketId = null;
        broadcast(room);
        scheduleCleanup(room);
      } catch (e) {
        log('error', 'disconnect_failed', errorFields(e));
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host ?? '0.0.0.0', resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    rooms,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(pruneTimer);
        for (const timer of cleanupTimers.values()) clearTimeout(timer);
        io.close(() => resolve());
      }),
  };
}