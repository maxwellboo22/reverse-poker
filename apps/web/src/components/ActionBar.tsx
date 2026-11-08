import { useState } from 'react';
import type { ClientAction, TableView } from '@reverse-poker/shared';
import { useGame } from '../net/game';

export function ActionBar({ view }: { view: TableView }) {
  const { act } = useGame();
  const legal = view.legalActions;
  const [amount, setAmount] = useState(legal?.minRaiseTo ?? 0);
  const [error, setError] = useState<string | null>(null);

  if (view.phase === 'complete') return null;
  if (!legal) {
    const who = view.toAct === null ? null : view.seats[view.toAct]?.name;
    return <p className="hint">{who ? `Waiting for ${who}…` : 'Waiting…'}</p>;
  }

  const send = async (action: ClientAction) => {
    setError(null);
    const err = await act(action);
    if (err) setError(err);
  };

  const to = Math.min(Math.max(amount, legal.minRaiseTo), legal.maxRaiseTo);

  return (
    <div className="actions">
      <p className="hint turn">Your turn</p>
      <div className="row">
        <button onClick={() => send({ type: 'fold' })}>Fold</button>
        {legal.canCheck && <button onClick={() => send({ type: 'check' })}>Check</button>}
        {legal.canCall && <button onClick={() => send({ type: 'call' })}>Call {legal.callAmount}</button>}
      </div>
      {legal.canRaise && (
        <div className="row">
          <input
            type="range"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={to}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
          <input
            type="number"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={to}
            onChange={(e) => setAmount(Math.floor(Number(e.target.value)) || 0)}
          />
          <button onClick={() => send({ type: 'raise', amount: to })}>
            {to === legal.maxRaiseTo ? `All-in (${to})` : `Raise to ${to}`}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}