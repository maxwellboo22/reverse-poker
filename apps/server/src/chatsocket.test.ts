import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { Ack, ChatMessage, ChatReply, LobbyView, Session, TableView } from '@reverse-poker/shared';
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
  messages: Map<number, ChatMessage>; // keyed by id, so repeats are ignored (like the real client)
  history: ChatMessage[] | null;
  kicked: number;
  cleared: number;
  session?: Session;
}

async function connectClient(): Promise<Client> {
  const socket = connect(`http://127.0.0.1:${server.port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  const c: Client = {
    socket, lobby: null, view: null, messages: new Map(), history: null, kicked: 0, cleared: 0,
  };
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
  socket.on('room:kicked', () => {
    c.kicked += 1;
  });
  socket.on('chat:message', (m: ChatMessage) => {
    c.messages.set(m.id, m);
  });
  socket.on('chat:history', (list: ChatMessage[]) => {
    c.history = list;
    for (const m of list) c.messages.set(m.id, m);
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

const texts = (c: Client) => [...c.messages.values()].map((m) => m.text);

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

type ChatAck = Ack<{ reply?: ChatReply }>;
const say = (c: Client, text: string) => call<ChatAck>(c.socket, 'chat:send', { text });

describe('chat over real sockets', () => {
  it('messages reach everyone; command answers go only to the sender', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];

    expect(await say(alice, 'hello everyone')).toMatchObject({ ok: true });
    await until(() => texts(alice).includes('hello everyone') && texts(bob).includes('hello everyone'));
    expect([...bob.messages.values()].find((m) => m.text === 'hello everyone')).toMatchObject({
      kind: 'user', name: 'Alice',
    });

    const before = alice.messages.size;
    const res = await say(bob, '/help');
    expect(res).toMatchObject({ ok: true, reply: { ok: true } });
    if (res.ok) expect(res.reply?.text).toContain('/rule');
    await new Promise((r) => setTimeout(r, 50));
    expect(alice.messages.size).toBe(before); // Alice never saw Bob's help
  });

  it('a late joiner receives the history', async () => {
    const alice = await connectClient();
    const created = await call<Ack<{ session: Session }>>(alice.socket, 'room:create', { name: 'Alice' });
    if (!created.ok) throw new Error(created.error);
    expect(await say(alice, 'first message')).toMatchObject({ ok: true });

    const bob = await connectClient();
    const joined = await call<Ack<{ session: Session }>>(bob.socket, 'room:join', {
      code: created.session.code, name: 'Bob',
    });
    expect(joined.ok).toBe(true);
    await until(() => bob.history !== null);
    expect(bob.history!.map((m) => m.text)).toContain('first message');
  });

  it('rejects empty, oversized and malformed messages, and rate-limits floods', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice] = clients as [Client, Client];

    expect(await say(alice, '   ')).toEqual({ ok: false, error: 'bad_request' });
    expect(await say(alice, 'x'.repeat(301))).toEqual({ ok: false, error: 'bad_request' });
    expect(await call<ChatAck>(alice.socket, 'chat:send', 'not an object')).toEqual({
      ok: false, error: 'bad_request',
    });

    // Three requests are already used up; the sixth in a row is the last one allowed.
    const results: ChatAck[] = [];
    for (let i = 0; i < 4; i++) results.push(await say(alice, `msg ${i}`));
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(results[3]).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('a stranger outside any room cannot chat', async () => {
    const stranger = await connectClient();
    expect(await say(stranger, 'hi')).toEqual({ ok: false, error: 'not_in_room' });
  });
});

describe('host commands over real sockets', () => {
  it('only the host can add a rule; everyone sees it in the lobby and the chat', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];
    const rule = '/rule if someone wins then everyone pays them 10 chips';

    expect(await say(bob, rule)).toMatchObject({
      ok: true, reply: { ok: false, text: 'Only the host can do that.' },
    });
    expect(bob.lobby!.houseRules).toHaveLength(0);

    expect(await say(alice, rule)).toMatchObject({ ok: true });
    await until(() => alice.lobby?.houseRules.length === 1 && bob.lobby?.houseRules.length === 1);
    await until(() => texts(bob).some((t) => t.startsWith('Rule 1 added')));
    expect(bob.lobby!.houseRules[0]).toMatchObject({ number: 1, active: true });
  });

  it('a mistyped command gives only the sender an error', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];
    const before = bob.messages.size;
    const res = await say(alice, '/rule if someone wins then dance');
    expect(res).toMatchObject({ ok: true, reply: { ok: false } });
    await new Promise((r) => setTimeout(r, 50));
    expect(bob.messages.size).toBe(before);
    expect(alice.lobby!.houseRules).toHaveLength(0);
  });

  it('/kick removes the player, tells them, and they lose all power in the room', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob', 'Cara']);
    const [alice, bob, cara] = clients as [Client, Client, Client];

    expect(await say(bob, '/kick Cara')).toMatchObject({ ok: true, reply: { ok: false } });
    expect(cara.kicked).toBe(0);

    expect(await say(alice, '/kick Bob')).toMatchObject({ ok: true });
    await until(() => bob.kicked === 1);
    await until(() => alice.lobby?.players.length === 2 && cara.lobby?.players.length === 2);
    await until(() => texts(cara).includes('Bob was removed by the host.'));
    expect(await say(bob, 'am I still here?')).toEqual({ ok: false, error: 'not_in_room' });
    expect(await call<Ack>(bob.socket, 'game:start')).toEqual({ ok: false, error: 'not_in_room' });
  });

  it('/chips changes the chips between hands and announces it', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];
    const bobId = bob.session!.playerId;

    expect(await say(alice, '/chips Bob 250')).toMatchObject({ ok: true });
    await until(() => bob.lobby?.players.find((p) => p.playerId === bobId)?.chips === 250);
    await until(() => texts(alice).includes('Bob now has 250 chips (set by the host).'));
  });

  it('/reset clears every table and restores everyone\'s chips', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];

    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: true });
    await until(() => alice.view !== null && bob.view !== null);

    expect(await say(alice, '/reset')).toMatchObject({ ok: true });
    await until(() => alice.cleared === 1 && bob.cleared === 1);
    await until(() => {
      const l = alice.lobby;
      return l !== null && !l.handInProgress && l.players.every((p) => p.chips === 1000);
    });
  });

  it('/blinds changes the rules for everyone', async () => {
    const { clients } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];
    expect(await say(alice, '/blinds 25/50')).toMatchObject({ ok: true });
    await until(() => bob.lobby?.settings.bigBlind === 50 && bob.lobby?.settings.smallBlind === 25);
  });
});

describe('rules after a hand, over real sockets', () => {
  it('announces the payout and keeps every table and the lobby in agreement', async () => {
    const { clients, code } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = clients as [Client, Client];
    const room = server.rooms.get(code)!;

    // Any winner triggers this rule, so the test does not depend on the random deal.
    expect(await say(alice, '/rule if someone wins then everyone pays them 10 chips')).toMatchObject({ ok: true });
    await until(() => alice.lobby?.houseRules.length === 1 && bob.lobby?.houseRules.length === 1);

    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: true });
    await until(() => alice.view !== null && bob.view !== null);

    let guard = 0;
    while (room.handInProgress) {
      if (guard++ > 50) throw new Error('hand did not finish');
      const hand = room.hand!;
      const id = hand.seats[hand.toAct!]!.playerId;
      const who = clients.find((c) => c.session!.playerId === id)!;
      const legal = who.view!.legalActions;
      expect(legal).not.toBeNull();
      expect(await call<Ack>(who.socket, 'game:action', { type: legal!.canCheck ? 'check' : 'call' })).toEqual({
        ok: true,
      });
      const version = room.hand!.version;
      await until(() => clients.every((c) => c.view?.version === version));
    }

    await until(() => clients.every((c) => texts(c).some((t) => t.startsWith('Rule 1 triggered'))));
    for (const c of clients) {
      const view = c.view!;
      expect(view.phase).toBe('complete');
      for (const p of c.lobby!.players) {
        expect(view.seats.find((s) => s.playerId === p.playerId)!.stack).toBe(p.chips);
      }
      expect(c.lobby!.players.reduce((sum, p) => sum + p.chips, 0)).toBe(2000);
    }
  });
});