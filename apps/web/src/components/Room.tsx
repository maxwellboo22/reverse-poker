import { useEffect, useState } from 'react';
import type { LobbyPlayer } from '@reverse-poker/shared';
import { useGame } from '../net/game';
import { SettingsPanel } from './SettingsPanel';
import { Table } from './Table';

function PlayerRow({
  player, youId, hostId, handInProgress, onSetChips, onKick,
}: {
  player: LobbyPlayer;
  youId: string;
  hostId: string;
  handInProgress: boolean;
  /** Host-only actions; null for everyone else. */
  onSetChips: ((playerId: string, chips: number) => Promise<string | null>) | null;
  onKick: ((playerId: string) => Promise<string | null>) | null;
}) {
  const [value, setValue] = useState(String(player.chips));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(String(player.chips));
  }, [player.chips]);

  const save = async () => {
    if (!onSetChips) return;
    const chips = Number(value);
    if (value.trim() === '' || !Number.isInteger(chips) || chips < 0) {
      setError('Enter a whole number, 0 or more.');
      return;
    }
    setError(await onSetChips(player.playerId, chips));
  };

  const kick = async () => {
    if (!onKick) return;
    const warning = handInProgress
      ? `Remove ${player.name}? They fold, and their bets this round are returned.`
      : `Remove ${player.name} from the room?`;
    if (!window.confirm(warning)) return;
    setError(await onKick(player.playerId));
  };

  return (
    <li>
      {player.name}
      {player.playerId === hostId && ' ★'}
      {player.playerId === youId && ' (you)'} — {player.chips} chips
      {!player.connected && <span className="hint"> • offline</span>}
      {onSetChips && (
        <span className="inline">
          <input
            type="number"
            min={0}
            value={value}
            disabled={handInProgress}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="secondary" disabled={handInProgress} onClick={save}>
            Set chips
          </button>
        </span>
      )}
      {onKick && player.playerId !== youId && (
        <span className="inline">
          <button className="danger" onClick={kick}>
            Kick
          </button>
        </span>
      )}
      {error && <span className="error"> {error}</span>}
    </li>
  );
}

export function Room() {
  const { lobby, view, startGame, leaveRoom, resetLobby, setChips, setSettings, kickPlayer } = useGame();
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

  const reset = async () => {
    if (!window.confirm('Reset the lobby? This ends the current hand and restores everyone to the starting chips.')) {
      return;
    }
    setError(null);
    setError(await resetLobby());
  };

  return (
    <>
      <section className="panel">
        <p>
          Room code: <strong className="roomcode">{lobby.code}</strong>
          <span className="hint"> — share it with friends</span>
        </p>
        <ul className="players">
          {lobby.players.map((p) => (
            <PlayerRow
              key={p.playerId}
              player={p}
              youId={lobby.you}
              hostId={lobby.hostId}
              handInProgress={lobby.handInProgress}
              onSetChips={isHost ? setChips : null}
              onKick={isHost ? kickPlayer : null}
            />
          ))}
        </ul>
        {isHost && lobby.handInProgress && (
          <p className="hint">Chips can only be changed between hands.</p>
        )}

        <SettingsPanel settings={lobby.settings} isHost={isHost} onSave={setSettings} />

        <div className="row">
          {isHost && !lobby.handInProgress && (
            <button disabled={!playable} onClick={start}>
              {view ? 'Deal next hand' : 'Start game'}
            </button>
          )}
          {isHost && (
            <button className="danger" onClick={reset}>
              Reset lobby
            </button>
          )}
          <button className="secondary" onClick={leave}>
            Leave room
          </button>
        </div>
        {!isHost && !lobby.handInProgress && <p className="hint">Waiting for the host to deal…</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {view && <Table view={view} />}
    </>
  );
}