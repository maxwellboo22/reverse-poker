import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { Ack, ChatReply, Session } from '@reverse-poker/shared';
import { startGameServer, type GameServer, type GameServerOptions } from './net/server';

const servers: GameServer[] = [];
const sockets: Socket[] = [];

async function start(opts: Partial<GameServerOptions> = {}): Promise<GameServer> {
  const s = await startGameServer({ port: 0, ...opts });
  servers.push(s);
  return s;
}

afterEach(async () => {
  for (const s of sockets) s.close();
  sockets.length = 0;
  for (const s of servers) await s.close();
  servers.length = 0;
});

function open(server: GameServer, extraHeaders: Record<string, string> = {}): Socket {
  const socket = connect(`http://127.0.0.1:${server.port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders,
  });
  sockets.push(socket);
  return socket;
}

/** "connected", or the reason the server refused us. */
function outcome(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.on('connect', () => resolve('connected'));
    socket.on('connect_error', (e: Error) => resolve(e.message));
  });
}

async function connected(server: GameServer, headers: Record<string, string> = {}): Promise<Socket> {
  const s = open(server, headers);
  expect(await outcome(s)).toBe('connected');
  return s;
}

function call<T>(socket: Socket, event: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve) => {
    socket.emit(event, ...args, (res: T) => resolve(res));
  });
}

const createRoom = (s: Socket, name = 'Host') =>
  call<Ack<{ session: Session }>>(s, 'room:create', { name });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

describe('connection limits', () => {
  it('limits connections per address, and frees the slot when one closes', async () => {
    const server = await start({ limits: { maxConnectionsPerIp: 2 } });
    const a = await connected(server);
    await connected(server);
    expect(await outcome(open(server))).toBe('too_many_connections');

    a.close();
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      const s = open(server);
      ok = (await outcome(s)) === 'connected';
      if (!ok) await sleep(25);
    }
    expect(ok).toBe(true);
  });

  it('limits connections in total', async () => {
    const server = await start({ limits: { maxConnections: 2 } });
    await connected(server);
    await connected(server);
    expect(await outcome(open(server))).toBe('server_busy');
  });

  it('ignores X-Forwarded-For unless proxies are trusted (it can be forged)', async () => {
    const server = await start({ limits: { maxConnectionsPerIp: 1 } });
    await connected(server, { 'X-Forwarded-For': '1.1.1.1' });
    expect(await outcome(open(server, { 'X-Forwarded-For': '2.2.2.2' }))).toBe('too_many_connections');
  });

  it('uses the proxy-supplied address when proxies are trusted', async () => {
    const server = await start({ limits: { maxConnectionsPerIp: 1 }, trustProxyHops: 1 });
    await connected(server, { 'X-Forwarded-For': '1.1.1.1' });
    await connected(server, { 'X-Forwarded-For': '2.2.2.2' });
    expect(await outcome(open(server, { 'X-Forwarded-For': '1.1.1.1' }))).toBe('too_many_connections');
  });
});

describe('other websites', () => {
  it('only lets the configured site open a connection', async () => {
    const server = await start({ clientOrigin: 'https://good.example.com' });
    expect(await outcome(open(server, { Origin: 'https://evil.example.com' }))).not.toBe('connected');
    expect(await outcome(open(server, { Origin: 'https://good.example.com' }))).toBe('connected');
    expect(await outcome(open(server))).toBe('connected'); // no Origin header: scripts and tests
  });
});

describe('rooms', () => {
  it('stops creating rooms at the cap, and frees space when a room empties', async () => {
    const server = await start({ limits: { maxRooms: 2 } });
    const [a, b, c] = [await connected(server), await connected(server), await connected(server)];
    expect((await createRoom(a)).ok).toBe(true);
    expect((await createRoom(b)).ok).toBe(true);
    expect(await createRoom(c)).toEqual({ ok: false, error: 'server_full' });

    expect(await call<Ack>(a, 'room:leave')).toEqual({ ok: true });
    expect((await createRoom(c)).ok).toBe(true);
  });

  it('limits how many rooms one address can create', async () => {
    const server = await start({ limits: { roomCreatesPerIpPerHour: 2 } });
    const [a, b, c] = [await connected(server), await connected(server), await connected(server)];
    expect((await createRoom(a)).ok).toBe(true);
    expect((await createRoom(b)).ok).toBe(true);
    expect(await createRoom(c)).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('slows down people guessing room codes', async () => {
    const server = await start({ limits: { failedJoinsPerIpPer5Min: 3 } });
    const s = await connected(server);
    for (let i = 0; i < 3; i++) {
      expect(await call<Ack>(s, 'room:join', { code: 'ZZZZZ', name: 'Guess' })).toEqual({
        ok: false, error: 'room_not_found',
      });
    }
    expect(await call<Ack>(s, 'room:join', { code: 'ZZZZZ', name: 'Guess' })).toEqual({
      ok: false, error: 'rate_limited',
    });
  });
});

describe('floods and crashes', () => {
  it('rate-limits a connection that spams messages, then disconnects it', async () => {
    const server = await start({ limits: { eventsPerSocketPer10s: 5 } });
    const s = await connected(server);
    for (let i = 0; i < 5; i++) {
      expect(await call<Ack>(s, 'game:start')).toEqual({ ok: false, error: 'not_in_room' });
    }
    expect(await call<Ack>(s, 'game:start')).toEqual({ ok: false, error: 'rate_limited' });

    for (let i = 0; i < 20; i++) s.emit('game:start', () => {});
    await until(() => !s.connected);
  });

  it('a bug inside a handler is an error reply, not a crash', async () => {
    const server = await start();
    const a = await connected(server);
    const created = await createRoom(a);
    if (!created.ok) throw new Error(created.error);

    const room = server.rooms.get(created.session.code)!;
    room.handleChat = () => {
      throw new Error('boom');
    };
    expect(await call<Ack<{ reply?: ChatReply }>>(a, 'chat:send', { text: 'hello' })).toEqual({
      ok: false, error: 'server_error',
    });

    // The server is still alive and other people can still play.
    const b = await connected(server);
    expect((await createRoom(b, 'Other')).ok).toBe(true);
  });
});

describe('plain web requests', () => {
  it('answers /health, hides everything else, and sets a safety header', async () => {
    const server = await start();
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`http://127.0.0.1:${server.port}/anything`)).status).toBe(404);
  });
});