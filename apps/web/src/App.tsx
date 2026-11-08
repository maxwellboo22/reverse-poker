import { Home } from './components/Home';
import { Room } from './components/Room';
import { useGame } from './net/game';

export default function App() {
  const { session, connected, notice, dismissNotice } = useGame();
  return (
    <div className="app">
      <h1>Reverse Poker</h1>
      {!connected && <div className="banner">Connecting to the server…</div>}
      {notice && (
        <div className="banner">
          {notice}{' '}
          <button className="secondary" onClick={dismissNotice}>
            OK
          </button>
        </div>
      )}
      {session ? <Room /> : <Home />}
    </div>
  );
}