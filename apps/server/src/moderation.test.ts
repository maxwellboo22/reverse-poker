import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { Ack, LobbyView, RoomSettings, Session, TableView } from '@reverse-poker/shared';
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
  kicked: number;
  session?: Session;
}

async function connectClient(): Promise<Client> {
  const socket = connect(`http://127.0.0.1:${server.port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  const c: Client = { socket, lobby: null, view: null, kicked: 0 };
  socket.on('room:lobby', (l: LobbyView) => {
    c.lobby = l;
  });
  socket.on('table:view', (v: TableView) => {
    c.view = v;
  });
  socket.on('room:kicked', () => {
    c.kicked += 1;
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

const custom: RoomSettings = {
  smallBlind: 25, bigBlind: 50, minRaise: 100, bettingRounds: 2, wrapAroundStraights: true,
};

describe('host rules over real sockets', () => {
  it('only the host can change them, and everyone sees the result', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];

    expect(await call<Ack>(bob.socket, 'host:setSettings', custom)).toEqual({ ok: false, error: 'not_host' });
    expect(await call<Ack>(alice.socket, 'host:setSettings', { ...custom, bettingRounds: 9 })).toEqual({
      ok: false, error: 'bad_request',
    });
    expect(await call<Ack>(alice.socket, 'host:setSettings', { ...custom, smallBlind: 99 })).toEqual({
      ok: false, error: 'blinds_order',
    });

    expect(await call<Ack>(alice.socket, 'host:setSettings', custom)).toEqual({ ok: true });
    await until(() => JSON.stringify(bob.lobby?.settings) === JSON.stringify(custom));
  });
});

describe('kicking over real sockets', () => {
  it('removes the player, tells them, and updates everyone else', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob', 'Cara']);
    const [alice, bob, cara] = clients as [Client, Client, Client];
    const bobId = bob.session!.playerId;

    expect(await call<Ack>(bob.socket, 'host:kick', { playerId: alice.session!.playerId })).toEqual({
      ok: false, error: 'not_host',
    });
    expect(await call<Ack>(alice.socket, 'host:kick', { playerId: alice.session!.playerId })).toEqual({
      ok: false, error: 'cannot_kick_self',
    });
    expect(await call<Ack>(alice.socket, 'host:kick', { playerId: 'ghost' })).toEqual({
      ok: false, error: 'no_such_player',
    });

    expect(await call<Ack>(alice.socket, 'host:kick', { playerId: bobId })).toEqual({ ok: true });
    await until(() => bob.kicked === 1);
    await until(() => cara.lobby?.players.length === 2 && alice.lobby?.players.length === 2);
    expect(alice.lobby!.players.map((p) => p.name)).toEqual(['Alice', 'Cara']);

    // The kicked player's connection no longer has any power in the room.
    expect(await call<Ack>(bob.socket, 'game:start')).toEqual({ ok: false, error: 'not_in_room' });
    expect(await call<Ack>(bob.socket, 'host:setChips', { playerId: bobId, chips: 5 })).toEqual({
      ok: false, error: 'not_in_room',
    });
  });

  it('kicking mid-hand folds the player and finishes the hand for the rest', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];

    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: true });
    await until(() => alice.view !== null && bob.view !== null);

    expect(await call<Ack>(alice.socket, 'host:kick', { playerId: bob.session!.playerId })).toEqual({ ok: true });
    await until(() => alice.view?.phase === 'complete');
    // Bob's big blind went back to him, so Alice only "wins" her own small blind.
    expect(alice.view!.result!.winners.map((w) => w.amount)).toEqual([5]);
    await until(() => bob.kicked === 1);
  });
});