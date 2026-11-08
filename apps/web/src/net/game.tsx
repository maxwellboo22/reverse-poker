import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  Ack, ClientAction, ClientToServerEvents, LobbyView, RoomSettings, ServerToClientEvents,
  Session, TableView,
} from '@reverse-poker/shared';

const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? `http://${window.location.hostname}:3001`;
const SESSION_KEY = 'reverse-poker-session';

// Per-tab storage: refresh keeps your seat, and each tab can be a different player.
function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable: resuming after a refresh just won't work
  }
}

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL);

function request<T extends object = object>(event: string, ...args: unknown[]): Promise<Ack<T>> {
  return new Promise((resolve) => {
    (socket as unknown as Socket)
      .timeout(5000)
      .emit(event, ...args, (err: Error | null, res: Ack<T>) => {
        resolve(err ? { ok: false, error: 'timeout' } : res);
      });
  });
}

const ERROR_TEXT: Record<string, string> = {
  room_not_found: 'No room with that code.',
  room_full: 'That room is full.',
  game_in_progress: 'A hand is in progress. You can join between hands.',
  name_taken: 'Someone in that room already has that name.',
  bad_request: 'Please check what you typed.',
  blinds_order: "The small blind can't be bigger than the big blind.",
  not_host: 'Only the host can do that.',
  cannot_kick_self: "You can't remove yourself. Use Leave room instead.",
  not_enough_players: 'You need at least 2 players with chips.',
  hand_in_progress: 'You can only do that between hands.',
  no_such_player: 'That player is no longer in the room.',
  not_your_turn: "It's not your turn.",
  illegal_raise: "That raise isn't allowed.",
  illegal_check: "You can't check right now.",
  illegal_call: "You can't call right now.",
  hand_over: 'That hand is over.',
  not_in_room: 'You are not in a room.',
  already_in_room: 'You are already in a room.',
  timeout: 'The server did not respond.',
};

export const describeError = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

interface GameApi {
  connected: boolean;
  session: Session | null;
  lobby: LobbyView | null;
  view: TableView | null;
  /** A message to show at the top of the page (for example, after being kicked). */
  notice: string | null;
  dismissNotice(): void;
  /** Each action resolves to null on success or an error message. */
  createRoom(name: string): Promise<string | null>;
  joinRoom(code: string, name: string): Promise<string | null>;
  leaveRoom(): Promise<string | null>;
  startGame(): Promise<string | null>;
  resetLobby(): Promise<string | null>;
  setChips(playerId: string, chips: number): Promise<string | null>;
  setSettings(settings: RoomSettings): Promise<string | null>;
  kickPlayer(playerId: string): Promise<string | null>;
  act(action: ClientAction): Promise<string | null>;
}

const GameContext = createContext<GameApi | null>(null);

export function useGame(): GameApi {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(socket.connected);
  const [session, setSession] = useState<Session | null>(loadSession);
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [view, setView] = useState<TableView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resetLocal = useCallback(() => {
    saveSession(null);
    setSession(null);
    setLobby(null);
    setView(null);
  }, []);

  useEffect(() => {
    const resume = async () => {
      const saved = loadSession();
      if (!saved) return;
      const res = await request<{ session: Session }>('room:resume', {
        code: saved.code, playerId: saved.playerId, token: saved.token,
      });
      if (res.ok) {
        setSession(res.session);
      } else if (res.error === 'bad_session') {
        resetLocal(); // the room is gone, or we were removed from it
        setNotice('Your previous room is no longer available.');
      }
    };
    const onConnect = () => {
      setConnected(true);
      void resume(); // every new connection must re-identify itself
    };
    const onDisconnect = () => setConnected(false);
    const onLobby = (l: LobbyView) => setLobby(l);
    const onView = (v: TableView) => setView(v);
    const onClear = () => setView(null);
    const onKicked = () => {
      resetLocal();
      setNotice('The host removed you from the room.');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room:lobby', onLobby);
    socket.on('table:view', onView);
    socket.on('table:clear', onClear);
    socket.on('room:kicked', onKicked);
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room:lobby', onLobby);
      socket.off('table:view', onView);
      socket.off('table:clear', onClear);
      socket.off('room:kicked', onKicked);
    };
  }, [resetLocal]);

  const enter = useCallback(async (event: 'room:create' | 'room:join', payload: object) => {
    const res = await request<{ session: Session }>(event, payload);
    if (!res.ok) return describeError(res.error);
    saveSession(res.session);
    setSession(res.session);
    setNotice(null);
    return null;
  }, []);

  const api = useMemo<GameApi>(
    () => ({
      connected,
      session,
      lobby,
      view,
      notice,
      dismissNotice: () => setNotice(null),
      createRoom: (name) => enter('room:create', { name }),
      joinRoom: (code, name) => enter('room:join', { code, name }),
      leaveRoom: async () => {
        const res = await request('room:leave');
        // If the server no longer knows us, there is nothing to leave: just clean up here.
        if (!res.ok && res.error !== 'not_in_room') return describeError(res.error);
        resetLocal();
        return null;
      },
      startGame: async () => {
        const res = await request('game:start');
        return res.ok ? null : describeError(res.error);
      },
      resetLobby: async () => {
        const res = await request('game:reset');
        return res.ok ? null : describeError(res.error);
      },
      setChips: async (playerId, chips) => {
        const res = await request('host:setChips', { playerId, chips });
        return res.ok ? null : describeError(res.error);
      },
      setSettings: async (settings) => {
        const res = await request('host:setSettings', settings);
        return res.ok ? null : describeError(res.error);
      },
      kickPlayer: async (playerId) => {
        const res = await request('host:kick', { playerId });
        return res.ok ? null : describeError(res.error);
      },
      act: async (action) => {
        const res = await request('game:action', action);
        return res.ok ? null : describeError(res.error);
      },
    }),
    [connected, session, lobby, view, notice, enter, resetLocal],
  );

  return <GameContext.Provider value={api}>{children}</GameContext.Provider>;
}