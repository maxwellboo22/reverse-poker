import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  Ack, ChatMessage, ChatReply, ClientAction, ClientToServerEvents, LobbyView, ServerToClientEvents,
  Session, TableView,
} from '@reverse-poker/shared';

const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? `http://${window.location.hostname}:3001`;
// To test several players in one browser, open the site with ?as=1, ?as=2, and so on:
// each one then keeps its own seat.
const SESSION_NAMESPACE = (new URLSearchParams(window.location.search).get('as') ?? '')
  .replace(/[^a-z0-9_-]/gi, '')
  .slice(0, 20);
const SESSION_KEY = SESSION_NAMESPACE ? `reverse-poker-session:${SESSION_NAMESPACE}` : 'reverse-poker-session';
const MAX_LOCAL_CHAT = 200;

// Per-tab storage: refresh keeps your seat, and each tab can be a different player.
// Kept in localStorage so your seat survives closing the tab or the browser.
function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
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
  rate_limited: "You're sending messages too fast. Wait a moment.",
  not_host: 'Only the host can do that.',
  not_enough_players: 'You need at least 2 players with chips.',
  hand_in_progress: 'You can only do that between hands.',
  not_your_turn: "It's not your turn.",
  illegal_raise: "That raise isn't allowed.",
  illegal_check: "You can't check right now.",
  illegal_call: "You can't call right now.",
  hand_over: 'That hand is over.',
  not_in_room: 'You are not in a room.',
  already_in_room: 'You are already in a room.',
  server_full: 'The server is full right now. Try again in a few minutes.',
  server_error: 'Something went wrong on the server. Please try again.',
  timeout: 'The server did not respond.',
};

export const describeError = (code: string): string => ERROR_TEXT[code] ?? `Something went wrong (${code}).`;

/** A chat line. `local` lines are private replies that only this browser shows. */
export interface ChatLine extends ChatMessage {
  local?: 'info' | 'error';
}

interface GameApi {
  connected: boolean;
  session: Session | null;
  lobby: LobbyView | null;
  view: TableView | null;
  chat: ChatLine[];
  /** A message to show at the top of the page (for example, after being kicked). */
  notice: string | null;
  dismissNotice(): void;
  /** Each action resolves to null on success or an error message. */
  createRoom(name: string): Promise<string | null>;
  joinRoom(code: string, name: string): Promise<string | null>;
  leaveRoom(): Promise<string | null>;
  startGame(): Promise<string | null>;
  act(action: ClientAction): Promise<string | null>;
  /** `keep` is true when the text should stay in the input box (it failed). */
  sendChat(text: string): Promise<{ keep: boolean; error: string | null }>;
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
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const localId = useRef(0);

  const resetLocal = useCallback(() => {
    saveSession(null);
    setSession(null);
    setLobby(null);
    setView(null);
    setChat([]);
  }, []);

  const addLocal = useCallback((text: string, kind: 'info' | 'error') => {
    setChat((prev) =>
      [...prev, { id: -(++localId.current), kind: 'system' as const, name: '', text, local: kind }].slice(
        -MAX_LOCAL_CHAT,
      ),
    );
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
    const onHistory = (messages: ChatMessage[]) => setChat(messages);
    const onMessage = (m: ChatMessage) =>
      // The server may send a message both in the history and live: ignore repeats.
      setChat((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m].slice(-MAX_LOCAL_CHAT)));

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room:lobby', onLobby);
    socket.on('table:view', onView);
    socket.on('table:clear', onClear);
    socket.on('room:kicked', onKicked);
    socket.on('chat:history', onHistory);
    socket.on('chat:message', onMessage);
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room:lobby', onLobby);
      socket.off('table:view', onView);
      socket.off('table:clear', onClear);
      socket.off('room:kicked', onKicked);
      socket.off('chat:history', onHistory);
      socket.off('chat:message', onMessage);
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
      chat,
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
      act: async (action) => {
        const res = await request('game:action', action);
        return res.ok ? null : describeError(res.error);
      },
      sendChat: async (text) => {
        const res = await request<{ reply?: ChatReply }>('chat:send', { text });
        if (!res.ok) return { keep: true, error: describeError(res.error) };
        if (res.reply) {
          addLocal(res.reply.text, res.reply.ok ? 'info' : 'error');
          return { keep: !res.reply.ok, error: null };
        }
        return { keep: false, error: null };
      },
    }),
    [connected, session, lobby, view, chat, notice, enter, resetLocal, addLocal],
  );

  return <GameContext.Provider value={api}>{children}</GameContext.Provider>;
}