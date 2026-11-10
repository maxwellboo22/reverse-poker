import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { Ack, ChatMessage, ChatReply, LobbyView, Session } from '@reverse-poker/shared';
import { parseCommand, type ParseContext } from './game/commands';
import { Room, type RoomPlayer } from './game/room';
import { startGameServer, type GameServer } from './net/server';

// ---------- the parser ----------

const ctx: ParseContext = {
  players: [
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob' },
    { id: 'c', name: 'Cara' },
  ],
  hostId: 'a',
};

describe('/host parsing', () => {
  it('understands names, numbers and a few aliases', () => {
    for (const text of ['/host Bob', '/host player 2', '/host to Bob', '/makehost Bob', '/promote Bob']) {
      expect(parseCommand(text, ctx)).toEqual({ ok: true, command: { kind: 'makeHost', playerId: 'b' } });
    }
    expect(parseCommand('/host Cara', ctx)).toEqual({ ok: true, command: { kind: 'makeHost', playerId: 'c' } });
  });

  it('asks who when the name is missing or unknown', () => {
    for (const text of ['/host', '/host nobody', '/host Bob please']) {
      const r = parseCommand(text, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('new host');
    }
  });
});

// ---------- the room ----------

function add(room: Room, name: string, online = true): RoomPlayer {
  const r = room.addPlayer(name);
  if (!r.ok) throw new Error(r.error);
  if (online) r.player.socketId = `sock-${name}`;
  return r.player;
}

function setup() {
  const room = new Room('HOST1');
  const alice = add(room, 'Alice');
  const bob = add(room, 'Bob');
  const cara = add(room, 'Cara', false); // offline
  room.takePendingChat();
  return { room, alice, bob, cara };
}

describe('handing over the host role', () => {
  it('moves every host power to the new host and announces it', () => {
    const { room, alice, bob } = setup();
    expect(room.handleChat(alice.playerId, '/host Bob')).toEqual({});
    expect(room.hostId).toBe(bob.playerId);
    expect(room.takePendingChat().map((m) => m.text)).toEqual([
      'Bob is now the host (appointed by Alice).',
    ]);
    expect(room.lobbyViewFor(alice.playerId).hostId).toBe(bob.playerId);

    // The old host has lost the powers...
    expect(room.handleChat(alice.playerId, '/reset').reply).toEqual({
      ok: false, text: 'Only the host can do that.',
    });
    expect(room.kick(alice.playerId, bob.playerId)).toEqual({ ok: false, error: 'not_host' });
    // ...and the new host has them.
    expect(room.handleChat(bob.playerId, '/blinds 25/50')).toEqual({});
    expect(room.settings).toMatchObject({ smallBlind: 25, bigBlind: 50 });
  });

  it('can be handed back and forth', () => {
    const { room, alice, bob } = setup();
    room.handleChat(alice.playerId, '/host Bob');
    room.handleChat(bob.playerId, '/host Alice');
    expect(room.hostId).toBe(alice.playerId);
  });

  it('is host-only', () => {
    const { room, bob } = setup();
    const out = room.handleChat(bob.playerId, '/host Bob');
    expect(out.reply).toEqual({ ok: false, text: 'Only the host can do that.' });
  });

  it('refuses the current host, someone offline, and someone who is not there', () => {
    const { room, alice, cara } = setup();
    expect(room.handleChat(alice.playerId, '/host Alice').reply?.text).toContain('already the host');
    expect(room.handleChat(alice.playerId, '/host Cara').reply?.text).toContain('offline');
    expect(room.handleChat(alice.playerId, '/host Zed').reply?.text).toContain('new host');
    expect(room.hostId).toBe(alice.playerId);
    expect(room.transferHost(alice.playerId, 'ghost')).toEqual({ ok: false, error: 'no_such_player' });
    expect(cara.socketId).toBeNull();
  });

  it('works in the middle of a hand without disturbing it', () => {
    const { room, alice, bob } = setup();
    room.removePlayer(room.players.values().next().value ? [...room.players.values()][2]!.playerId : '', false);
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    const version = room.hand!.version;
    expect(room.handleChat(alice.playerId, '/host Bob')).toEqual({});
    expect(room.hostId).toBe(bob.playerId);
    expect(room.hand!.version).toBe(version);
    expect(room.handInProgress).toBe(true);
  });

  it('rules written with "me" keep pointing at the person who wrote them', () => {
    const { room, alice, bob } = setup();
    room.handleChat(alice.playerId, '/rule if I win then everyone pays me 10');
    room.handleChat(alice.playerId, '/host Bob');
    expect(room.lobbyViewFor(bob.playerId).houseRules[0]!.text).toContain('If Alice wins');
  });

  it('after a handover, the new host leaving passes the role on again', () => {
    const { room, alice, bob } = setup();
    room.handleChat(alice.playerId, '/host Bob');
    room.removePlayer(bob.playerId);
    expect(room.hostId).toBe(alice.playerId);
  });
});

// ---------- over real sockets ----------

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
  messages: ChatMessage[];
  session?: Session;
}

async function connectClient(): Promise<Client> {
  const socket = connect(`http://127.0.0.1:${server.port}`, { transports: ['websocket'], forceNew: true });
  const c: Client = { socket, lobby: null, messages: [] };
  socket.on('room:lobby', (l: LobbyView) => {
    c.lobby = l;
  });
  socket.on('chat:message', (m: ChatMessage) => {
    c.messages.push(m);
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

type ChatAck = Ack<{ reply?: ChatReply }>;
const say = (c: Client, text: string) => call<ChatAck>(c.socket, 'chat:send', { text });

describe('handing over the host role over real sockets', () => {
  it('everyone sees the new host, and the powers switch', async () => {
    const alice = await connectClient();
    const created = await call<Ack<{ session: Session }>>(alice.socket, 'room:create', { name: 'Alice' });
    if (!created.ok) throw new Error(created.error);
    alice.session = created.session;

    const bob = await connectClient();
    const joined = await call<Ack<{ session: Session }>>(bob.socket, 'room:join', {
      code: created.session.code, name: 'Bob',
    });
    if (!joined.ok) throw new Error(joined.error);
    bob.session = joined.session;
    await until(() => alice.lobby?.players.length === 2 && bob.lobby?.players.length === 2);

    expect(await say(alice, '/host Bob')).toMatchObject({ ok: true });
    const bobId = bob.session.playerId;
    await until(() => alice.lobby?.hostId === bobId && bob.lobby?.hostId === bobId);
    await until(() => bob.messages.some((m) => m.text.includes('is now the host')));

    expect(await say(alice, '/rule if someone wins then everyone pays them 5')).toMatchObject({
      ok: true, reply: { ok: false, text: 'Only the host can do that.' },
    });
    expect(await say(bob, '/rule if someone wins then everyone pays them 5')).toMatchObject({ ok: true });
    await until(() => bob.lobby?.houseRules.length === 1 && alice.lobby?.houseRules.length === 1);
  });
});