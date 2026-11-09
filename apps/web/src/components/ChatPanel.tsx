import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useGame } from '../net/game';

export function ChatPanel({ isHost }: { isHost: boolean }) {
  const { chat, sendChat } = useGame();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    // A guard against fat-fingering the one command that wipes everyone's chips.
    if (/^\/reset\b/i.test(t) && !window.confirm('Reset the lobby? This ends the current hand and restores everyone to the starting chips.')) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await sendChat(t);
    setBusy(false);
    if (result.error) setError(result.error);
    if (!result.keep) setText('');
  };

  return (
    <div className="chat">
      <div className="chatlog" ref={logRef}>
        {chat.length === 0 && <p className="hint">No messages yet.</p>}
        {chat.map((m) => (
          <div
            key={m.id}
            className={['chatmsg', m.kind, m.local ? `local ${m.local}` : ''].join(' ')}
          >
            {m.kind === 'user' ? (
              <>
                <strong>{m.name}:</strong> {m.text}
              </>
            ) : (
              m.text
            )}
          </div>
        ))}
      </div>
      <form className="chatform" onSubmit={submit}>
        <input
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
          placeholder={isHost ? 'Message, or a command like /rule … (try /help)' : 'Type a message'}
        />
        <button type="submit" disabled={busy || text.trim() === ''}>
          Send
        </button>
      </form>
      {isHost && <p className="hint">You're the host: type /help to see commands for rules, kicking, chips and more.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}