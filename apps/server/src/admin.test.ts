import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { Ack, LobbyView, Session, TableView } from '@reverse-poker/shared';
import { startGameServer, type GameServer } from './net/server';

let server: GameServer;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startGameServer({ port: 0 });
});
afterAll(async () => {
  await server.close();
});
afterEach(() => {
  for (const s of sockets) s.close();
  sockets.length = 0;
});

interface Client {
  socket: Socket;
  lobby: LobbyView | null;
  view: TableView | null;
  cleared: number;
  session?: Session;
}

async function connectClient(): Promise<Client> {
  const socket = connect(`http://127.0.0.1:${server.port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  const c: Client = { socket, lobby: null, view: null, cleared: 0 };
  socket.on('room:lobby', (l: LobbyView) => {
    c.lobby = l;
  });
  socket.on('table:view', (v: TableView) => {
    c.view = v;
  });
  socket.on('table:clear', () => {
    c.cleared += 1;
    c.view = null;
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
  });
  sockets.push(socket);
  return c;
}

function call<T>(socket: Socket, event: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve) => {
    socket.emit(event, ...args, (res: T) => resolve(res));
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function seatPlayers(names: string[]) {
  const clients: Client[] = [];
  const host = await connectClient();
  const created = await call<Ack<{ session: Session }>>(host.socket, 'room:create', { name: names[0] });
  if (!created.ok) throw new Error(created.error);
  host.session = created.session;
  clients.push(host);

  for (const name of names.slice(1)) {
    const c = await connectClient();
    const joined = await call<Ack<{ session: Session }>>(c.socket, 'room:join', {
      code: created.session.code,
      name,
    });
    if (!joined.ok) throw new Error(joined.error);
    c.session = joined.session;
    clients.push(c);
  }
  await until(() => clients.every((c) => c.lobby?.players.length === names.length));
  return { clients, code: created.session.code };
}

describe('leaving a room', () => {
  it('updates the others, passes host on, and deletes an empty room', async () => {
    const { clients, code } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];

    expect(await call<Ack>(alice.socket, 'room:leave')).toEqual({ ok: true });
    await until(() => bob.lobby?.players.length === 1 && bob.lobby?.hostId === bob.session!.playerId);
    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: false, error: 'not_in_room' });

    expect(await call<Ack>(bob.socket, 'room:leave')).toEqual({ ok: true });
    await until(() => server.rooms.get(code) === undefined);
  });

  it('folds a player who leaves mid-hand and finishes the hand for the others', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];

    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: true });
    await until(() => alice.view !== null && bob.view !== null);

    expect(await call<Ack>(bob.socket, 'room:leave')).toEqual({ ok: true });
    await until(() => alice.view?.phase === 'complete');
    expect(alice.view!.result!.winners.map((w) => w.amount)).toEqual([5]);
    expect(alice.lobby!.players.map((p) => p.name)).toEqual(['Alice']);
  });
});

describe('host controls', () => {
  it('reset clears every table and restores chips; only the host may do it', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];
    const bobId = bob.session!.playerId;

    expect(await call<Ack>(alice.socket, 'host:setChips', { playerId: bobId, chips: 250 })).toEqual({ ok: true });
    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: true });
    await until(() => alice.view !== null && bob.view !== null);

    expect(await call<Ack>(bob.socket, 'game:reset')).toEqual({ ok: false, error: 'not_host' });
    expect(await call<Ack>(alice.socket, 'game:reset')).toEqual({ ok: true });
    await until(() => alice.cleared === 1 && bob.cleared === 1);
    await until(() => {
      const l = alice.lobby;
      return l !== null && !l.handInProgress && l.players.every((p) => p.chips === 1000);
    });
  });

  it('only the host can set chips, and only between hands', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];
    const aliceId = alice.session!.playerId;
    const bobId = bob.session!.playerId;

    expect(await call<Ack>(bob.socket, 'host:setChips', { playerId: aliceId, chips: 5 })).toEqual({
      ok: false, error: 'not_host',
    });
    expect(await call<Ack>(alice.socket, 'host:setChips', { playerId: bobId, chips: -1 })).toEqual({
      ok: false, error: 'bad_request',
    });
    expect(await call<Ack>(alice.socket, 'host:setChips', { playerId: bobId, chips: 250 })).toEqual({ ok: true });
    await until(() => bob.lobby?.players.find((p) => p.playerId === bobId)?.chips === 250);

    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: true });
    expect(await call<Ack>(alice.socket, 'host:setChips', { playerId: bobId, chips: 500 })).toEqual({
      ok: false, error: 'hand_in_progress',
    });
  });
});