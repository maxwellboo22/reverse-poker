import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { Ack, LobbyView, Session, TableView } from '@reverse-poker/shared';
import { startGameServer, type GameServer } from './net/server';

let server: GameServer;
const clients: TestClient[] = [];

beforeAll(async () => {
  server = await startGameServer({ port: 0 });
});
afterAll(async () => {
  await server.close();
});
afterEach(() => {
  for (const c of clients) c.socket.close();
  clients.length = 0;
});

// ---------- helpers ----------

interface TestClient {
  name: string;
  socket: Socket;
  packets: { event: string; json: string }[]; // everything the server ever sent us
  view: TableView | null;
  lobby: LobbyView | null;
  session?: Session;
}

async function connectClient(name: string): Promise<TestClient> {
  const socket = connect(`http://127.0.0.1:${server.port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  const c: TestClient = { name, socket, packets: [], view: null, lobby: null };
  socket.onAny((event: string, ...args: unknown[]) => {
    c.packets.push({ event, json: JSON.stringify(args) });
    if (event === 'table:view') c.view = args[0] as TableView;
    if (event === 'room:lobby') c.lobby = args[0] as LobbyView;
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
  });
  clients.push(c);
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
  const all: TestClient[] = [];
  const host = await connectClient(names[0]!);
  const created = await call<Ack<{ session: Session }>>(host.socket, 'room:create', { name: names[0] });
  if (!created.ok) throw new Error(created.error);
  host.session = created.session;
  all.push(host);

  for (const name of names.slice(1)) {
    const c = await connectClient(name);
    // lowercase on purpose: the server should normalise room codes
    const joined = await call<Ack<{ session: Session }>>(c.socket, 'room:join', {
      code: created.session.code.toLowerCase(),
      name,
    });
    if (!joined.ok) throw new Error(joined.error);
    c.session = joined.session;
    all.push(c);
  }
  await until(() => all.every((c) => c.lobby?.players.length === names.length));
  return { all, code: created.session.code, room: server.rooms.get(created.session.code)! };
}

function cardKeys(json: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.rank === 'number' && typeof o.suit === 'string') out.push(`${o.rank}${o.suit}`);
      else Object.values(o).forEach(walk);
    }
  };
  walk(JSON.parse(json));
  return out;
}

const EXPECTED_BOARD: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/**
 * Every packet a client received while the hand was live must contain exactly
 * the other players' hole cards plus the board that has been dealt. Nothing else.
 */
function assertWireClean(client: TestClient, holes: Record<string, string[]>): void {
  const me = client.session!.playerId;
  const othersCards = Object.entries(holes)
    .filter(([id]) => id !== me)
    .flatMap(([, cards]) => cards);

  for (const p of client.packets) {
    if (p.event === 'room:lobby') {
      expect(cardKeys(p.json)).toEqual([]); // the lobby never carries cards
      expect(p.json).not.toContain('token');
    }
    if (p.event !== 'table:view') continue;
    const view = (JSON.parse(p.json) as TableView[])[0]!;
    if (view.phase === 'complete') continue;

    expect(view.board).toHaveLength(EXPECTED_BOARD[view.phase]!);
    const board = view.board.map((c) => `${c.rank}${c.suit}`);
    expect(cardKeys(p.json).sort()).toEqual([...othersCards, ...board].sort());
  }
}

// ---------- tests ----------

describe('rooms', () => {
  it('enforces lobby rules', async () => {
    const stranger = await connectClient('Nobody');
    expect(await call<Ack>(stranger.socket, 'game:start')).toEqual({ ok: false, error: 'not_in_room' });
    expect(await call<Ack>(stranger.socket, 'game:action', { type: 'check' })).toEqual({
      ok: false, error: 'not_in_room',
    });
    expect(await call<Ack>(stranger.socket, 'room:join', { code: 'ZZZZZ', name: 'X' })).toEqual({
      ok: false, error: 'room_not_found',
    });
    expect(await call<Ack>(stranger.socket, 'room:create', { name: '   ' })).toEqual({
      ok: false, error: 'bad_request',
    });

    const { all } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = all as [TestClient, TestClient];
    expect(alice.lobby!.hostId).toBe(alice.session!.playerId);
    expect(await call<Ack>(bob.socket, 'game:start')).toEqual({ ok: false, error: 'not_host' });

    const dupe = await connectClient('Imposter');
    expect(
      await call<Ack>(dupe.socket, 'room:join', { code: alice.session!.code, name: 'alice' }),
    ).toEqual({ ok: false, error: 'name_taken' });
  });
});

describe('a full hand over real sockets', () => {
  it('never sends a player their own cards or undealt cards', async () => {
    const { all, room } = await seatPlayers(['Alice', 'Bob', 'Cara']);
    const [alice, bob] = all as [TestClient, TestClient, TestClient];

    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: true });
    await until(() => all.every((c) => c.view?.version === 0));

    // Ground truth, read straight from the server's memory.
    const hole = (id: string) =>
      room.hand!.seats.find((s) => s.playerId === id)!.holeCards!.map((c) => `${c.rank}${c.suit}`);
    const holes = Object.fromEntries(all.map((c) => [c.session!.playerId, hole(c.session!.playerId)]));

    // Rejections
    const actorId = room.hand!.seats[room.hand!.toAct!]!.playerId;
    const notActor = all.find((c) => c.session!.playerId !== actorId)!;
    const actor = all.find((c) => c.session!.playerId === actorId)!;
    expect(await call<Ack>(notActor.socket, 'game:action', { type: 'check' })).toEqual({
      ok: false, error: 'not_your_turn',
    });
    expect(await call<Ack>(actor.socket, 'game:action', { type: 'dance' })).toEqual({
      ok: false, error: 'bad_request',
    });
    expect(await call<Ack>(actor.socket, 'game:action', { type: 'raise', amount: -5 })).toEqual({
      ok: false, error: 'bad_request',
    });
    expect(await call<Ack>(bob.socket, 'room:join', { code: alice.session!.code, name: 'Late' })).toEqual({
      ok: false, error: 'already_in_room',
    });

    // Play it out: everyone checks or calls.
    let guard = 0;
    while (room.hand!.phase !== 'complete') {
      if (guard++ > 50) throw new Error('hand did not finish');
      const hand = room.hand!;
      const id = hand.seats[hand.toAct!]!.playerId;
      const who = all.find((c) => c.session!.playerId === id)!;
      const legal = who.view!.legalActions;
      expect(legal).not.toBeNull();
      const res = await call<Ack>(who.socket, 'game:action', { type: legal!.canCheck ? 'check' : 'call' });
      expect(res).toEqual({ ok: true });
      const version = room.hand!.version;
      await until(() => all.every((c) => c.view?.version === version));
    }

    // The important part: inspect everything each client ever received.
    for (const c of all) assertWireClean(c, holes);

    // After the hand, each player is shown their own cards and the totals add up.
    for (const c of all) {
      const view = c.view!;
      expect(view.phase).toBe('complete');
      expect(view.result).not.toBeNull();
      const mine = view.seats[view.youSeat]!.holeCards;
      expect(mine?.visibility).toBe('visible');
      if (mine?.visibility === 'visible') {
        expect(mine.cards.map((x) => `${x.rank}${x.suit}`)).toEqual(holes[c.session!.playerId]);
      }
      expect(view.seats.reduce((sum, s) => sum + s.stack, 0)).toBe(3000);
    }
  });
});

describe('reconnection', () => {
  it('lets a player resume with their token and rejects a wrong one', async () => {
    const { all, code } = await seatPlayers(['Alice', 'Bob']);
    const [alice, bob] = all as [TestClient, TestClient];
    expect(await call<Ack>(alice.socket, 'game:start')).toEqual({ ok: true });
    await until(() => all.every((c) => c.view !== null));

    const bobSession = bob.session!;
    bob.socket.close();
    await until(
      () => alice.view?.seats.find((s) => s.playerId === bobSession.playerId)?.connection === 'disconnected',
    );

    const bob2 = await connectClient('Bob again');
    const bad = await call<Ack>(bob2.socket, 'room:resume', {
      code, playerId: bobSession.playerId, token: 'x'.repeat(64),
    });
    expect(bad).toEqual({ ok: false, error: 'bad_session' });

    const good = await call<Ack>(bob2.socket, 'room:resume', {
      code, playerId: bobSession.playerId, token: bobSession.token,
    });
    expect(good.ok).toBe(true);

    await until(() => bob2.view !== null);
    const view = bob2.view!;
    expect(view.seats[view.youSeat]!.holeCards).toEqual({ visibility: 'hidden', count: 2 });
    const other = view.seats.find((s) => s.seat !== view.youSeat)!;
    expect(other.holeCards?.visibility).toBe('visible');

    await until(
      () => alice.view?.seats.find((s) => s.playerId === bobSession.playerId)?.connection === 'connected',
    );
  });
});