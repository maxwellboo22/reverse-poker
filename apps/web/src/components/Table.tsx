import type { SeatView, TableView } from '@reverse-poker/shared';
import { ActionBar } from './ActionBar';
import { CardBack, CardView } from './CardView';

const PHASE_LABEL: Record<string, string> = {
  waiting: 'Waiting', preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River',
  showdown: 'Showdown', complete: 'Hand complete',
};

function HoleCards({ hole }: { hole: SeatView['holeCards'] }) {
  if (!hole) return <div className="cards" />;
  if (hole.visibility === 'hidden') {
    return (
      <div className="cards">
        <CardBack />
        <CardBack />
      </div>
    );
  }
  return (
    <div className="cards">
      {hole.cards.map((c, i) => (
        <CardView key={i} card={c} />
      ))}
    </div>
  );
}

export function Table({ view }: { view: TableView }) {
  const pot = view.pots.reduce((sum, p) => sum + p.amount, 0);

  return (
    <section className="table">
      <div className="status">
        <strong>{PHASE_LABEL[view.phase] ?? view.phase}</strong>
        <span>Pot: {pot}</span>
        {view.pots.length > 1 && <span className="hint">({view.pots.map((p) => p.amount).join(' + ')})</span>}
      </div>

      <div className="board">
        {view.board.map((c, i) => (
          <CardView key={i} card={c} />
        ))}
      </div>

      <div className="seats">
        {view.seats.map((s) => (
          <div
            key={s.playerId}
            className={[
              'seat',
              s.seat === view.youSeat ? 'you' : '',
              s.seat === view.toAct ? 'acting' : '',
              s.status === 'folded' ? 'folded' : '',
            ].join(' ')}
          >
            <div className="name">
              {s.name}
              {s.seat === view.youSeat && ' (you)'}
              {s.connection === 'disconnected' && <span className="hint"> • offline</span>}
            </div>
            <HoleCards hole={s.holeCards} />
            <div className="meta">
              <span>Stack {s.stack}</span>
              {s.committedThisRound > 0 && <span>Bet {s.committedThisRound}</span>}
              {s.status !== 'active' && <span className="tag">{s.status === 'allIn' ? 'all-in' : s.status}</span>}
            </div>
          </div>
        ))}
      </div>

      {view.result && (
        <div className="result">
          {view.result.winners.map((w) => (
            <p key={w.seat}>
              {view.seats[w.seat]?.name} wins {w.amount}
              {w.handDescription ? ` with ${w.handDescription}` : ''}
            </p>
          ))}
          {view.result.refunds.map((r) => (
            <p key={`refund-${r.seat}`} className="hint">
              {view.seats[r.seat]?.name} gets {r.amount} back (uncalled bet)
            </p>
          ))}
        </div>
      )}

      <ActionBar key={`${view.version}-${view.phase}`} view={view} />
    </section>
  );
}