import type { CSSProperties } from 'react';
import type { SeatView, TableView } from '@reverse-poker/shared';
import { ActionBar } from './ActionBar';
import { CardBack, CardView } from './CardView';

const PHASE_LABEL: Record<string, string> = {
  waiting: 'Waiting', preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River',
  showdown: 'Showdown', complete: 'Hand complete',
};

/**
 * Where a seat sits around the table. Index 0 is you, at the bottom, and the
 * other seats follow clockwise (the next player to act is on your left).
 */
function around(index: number, count: number): CSSProperties {
  const angle = Math.PI / 2 + (index * 2 * Math.PI) / count;
  return {
    '--cx': Number(Math.cos(angle).toFixed(4)),
    '--cy': Number(Math.sin(angle).toFixed(4)),
  } as CSSProperties;
}

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
  const count = view.seats.length;
  const slots = Array.from({ length: 5 }, (_, i) => view.board[i] ?? null);

  return (
    <section className="table">
      <div className={`tablewrap${count > 6 ? ' big' : ''}`}>
        <div className="felt" />

        <div className="tcenter">
          <div className="potline">
            <strong>{PHASE_LABEL[view.phase] ?? view.phase}</strong>
            <span>Pot {pot}</span>
            {view.pots.length > 1 && (
              <span className="hint">({view.pots.map((p) => p.amount).join(' + ')})</span>
            )}
          </div>
          <div className="tboard">
            {slots.map((c, i) => (c ? <CardView key={i} card={c} /> : <div key={i} className="slot" />))}
          </div>
        </div>

        {view.seats.map((s) => {
          const index = (s.seat - view.youSeat + count) % count;
          const you = s.seat === view.youSeat;
          return (
            <div key={s.playerId} className="tslot" style={around(index, count)}>
              <div
                className={[
                  'tseat',
                  you ? 'you' : '',
                  s.seat === view.toAct ? 'acting' : '',
                  s.status === 'folded' ? 'folded' : '',
                ].join(' ')}
              >
                <HoleCards hole={s.holeCards} />
                <div className="plate">
                  <div className="pname">
                    {s.name}
                    {you && ' (you)'}
                  </div>
                  <div className="pmoney">
                    <span className="pstack">{s.stack}</span>
                    {s.committedThisRound > 0 && <span className="pbet">Bet {s.committedThisRound}</span>}
                  </div>
                  {(s.status === 'allIn' || s.status === 'folded' || s.connection === 'disconnected') && (
                    <div className="ptags">
                      {s.status === 'allIn' && <span className="tag">all-in</span>}
                      {s.status === 'folded' && <span className="tag">folded</span>}
                      {s.connection === 'disconnected' && <span className="tag">offline</span>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
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