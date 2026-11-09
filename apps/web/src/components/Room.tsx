import { useState } from 'react';
import { rulesSummary } from '@reverse-poker/shared';
import { useGame } from '../net/game';
import { ChatPanel } from './ChatPanel';
import { Table } from './Table';

export function Room() {
  const { lobby, view, startGame, leaveRoom } = useGame();
  const [error, setError] = useState<string | null>(null);

  if (!lobby) return <p className="hint">Joining room…</p>;

  const isHost = lobby.hostId === lobby.you;
  const playable = lobby.players.filter((p) => p.chips > 0).length >= 2;

  const start = async () => {
    setError(null);
    setError(await startGame());
  };

  const leave = async () => {
    if (lobby.handInProgress && !window.confirm('Leave mid-hand? You will fold, and your bets this round are returned.')) {
      return;
    }
    setError(null);
    setError(await leaveRoom()); // on success this screen goes away
  };

  return (
    <>
      <section className="panel">
        <p>
          Room code: <strong className="roomcode">{lobby.code}</strong>
          <span className="hint"> — share it with friends</span>
        </p>

        <ul className="players">
          {lobby.players.map((p, i) => (
            <li key={p.playerId}>
              {i + 1}. {p.name}
              {p.playerId === lobby.hostId && ' ★'}
              {p.playerId === lobby.you && ' (you)'} — {p.chips} chips
              {!p.connected && <span className="hint"> • offline</span>}
            </li>
          ))}
        </ul>

        <p className="hint">Rules: {rulesSummary(lobby.settings)}</p>

        <strong>Special rules</strong>
        {lobby.houseRules.length === 0 ? (
          <p className="hint">None yet.{isHost && ' Add one in the chat with /rule (see /help).'}</p>
        ) : (
          <ol className="houserules">
            {lobby.houseRules.map((r) => (
              <li key={r.number} className={r.active ? '' : 'inactive'}>
                {r.text}
                {!r.active && <span className="hint"> (inactive: a player in this rule left)</span>}
              </li>
            ))}
          </ol>
        )}

        <div className="row">
          {isHost && !lobby.handInProgress && (
            <button disabled={!playable} onClick={start}>
              {view ? 'Deal next hand' : 'Start game'}
            </button>
          )}
          <button className="secondary" onClick={leave}>
            Leave room
          </button>
        </div>
        {!isHost && !lobby.handInProgress && <p className="hint">Waiting for the host to deal…</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <ChatPanel isHost={isHost} />
      </section>

      {view && <Table view={view} />}
    </>
  );
}