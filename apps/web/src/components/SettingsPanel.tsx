import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type RoomSettings } from '@reverse-poker/shared';

const ROUND_LABEL: Record<number, string> = {
  1: '1: pre-flop only',
  2: '2: pre-flop, flop',
  3: '3: pre-flop, flop, turn',
  4: '4: pre-flop, flop, turn, river',
};

export function rulesSummary(s: RoomSettings): string {
  const rounds = `${s.bettingRounds} betting round${s.bettingRounds === 1 ? '' : 's'}`;
  return `blinds ${s.smallBlind}/${s.bigBlind} · min raise ${s.minRaise} · ${rounds} · wrap-around straights ${
    s.wrapAroundStraights ? 'on' : 'off'
  }`;
}

interface Draft {
  smallBlind: string;
  bigBlind: string;
  minRaise: string;
  bettingRounds: string;
  wrapAroundStraights: boolean;
}

const toDraft = (s: RoomSettings): Draft => ({
  smallBlind: String(s.smallBlind),
  bigBlind: String(s.bigBlind),
  minRaise: String(s.minRaise),
  bettingRounds: String(s.bettingRounds),
  wrapAroundStraights: s.wrapAroundStraights,
});

const wholeNumber = (text: string): number | null => {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null;
};

export function SettingsPanel({
  settings, isHost, onSave,
}: {
  settings: RoomSettings;
  isHost: boolean;
  onSave: (settings: RoomSettings) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Reset the form only when the saved rules really change, not on every lobby update.
  const key = JSON.stringify(settings);
  useEffect(() => {
    setDraft(toDraft(settings));
  }, [key]);

  if (!isHost) return <p className="hint">Rules: {rulesSummary(settings)}</p>;

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    const smallBlind = wholeNumber(draft.smallBlind);
    const bigBlind = wholeNumber(draft.bigBlind);
    const minRaise = wholeNumber(draft.minRaise);
    if (smallBlind === null || bigBlind === null || minRaise === null) {
      setError('Blinds and minimum raise must be whole numbers of at least 1.');
      return;
    }
    if (smallBlind > bigBlind) {
      setError("The small blind can't be bigger than the big blind.");
      return;
    }
    const err = await onSave({
      smallBlind,
      bigBlind,
      minRaise,
      bettingRounds: Number(draft.bettingRounds),
      wrapAroundStraights: draft.wrapAroundStraights,
    });
    if (err) setError(err);
    else setSaved(true);
  };

  return (
    <div className="settings">
      <strong>Game rules</strong>
      <p className="hint">Changes apply from the next hand.</p>
      <div className="row">
        <label>
          Small blind
          <input type="number" min={1} value={draft.smallBlind} onChange={(e) => set('smallBlind', e.target.value)} />
        </label>
        <label>
          Big blind
          <input type="number" min={1} value={draft.bigBlind} onChange={(e) => set('bigBlind', e.target.value)} />
        </label>
        <label>
          Minimum raise
          <input type="number" min={1} value={draft.minRaise} onChange={(e) => set('minRaise', e.target.value)} />
        </label>
      </div>
      <label>
        Betting rounds
        <select value={draft.bettingRounds} onChange={(e) => set('bettingRounds', e.target.value)}>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {ROUND_LABEL[n]}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">With fewer than 4 rounds, the remaining board cards are dealt without betting.</p>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.wrapAroundStraights}
          onChange={(e) => set('wrapAroundStraights', e.target.checked)}
        />
        Allow wrap-around straights (J-Q-K-A-2, Q-K-A-2-3, K-A-2-3-4)
      </label>
      <p className="hint">Wrap-around straights rank below A-2-3-4-5, ordered by their last card.</p>
      <div className="row">
        <button onClick={save}>Save rules</button>
        <button
          className="secondary"
          onClick={() => {
            setDraft(toDraft(DEFAULT_SETTINGS));
            setSaved(false);
          }}
        >
          Fill in defaults
        </button>
      </div>
      {saved && <p className="hint">Saved. Applies from the next hand.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}