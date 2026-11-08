import { useState } from 'react';
import { useGame } from '../net/game';

export function Home() {
  const { createRoom, joinRoom, connected } = useGame();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
  };

  const ready = connected && !busy && name.trim().length > 0;

  return (
    <section className="panel">
      <label>
        Your name
        <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" />
      </label>

      <div className="row">
        <button disabled={!ready} onClick={() => run(() => createRoom(name))}>
          Create a room
        </button>
      </div>

      <p className="hint">or join a friend's room</p>
      <div className="row">
        <input
          className="code"
          value={code}
          maxLength={5}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="CODE"
        />
        <button disabled={!ready || code.trim().length !== 5} onClick={() => run(() => joinRoom(code, name))}>
          Join
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  );
}