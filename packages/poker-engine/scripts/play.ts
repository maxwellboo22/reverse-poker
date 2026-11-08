import type { Card, ClientAction, TableView } from '@reverse-poker/shared';
import { applyAction, computeLegalActions, startHand, toTableView, type HandState } from '../src/index';

const RANK_CHAR: Record<number, string> = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const fmt = (c: Card) => `${RANK_CHAR[c.rank] ?? c.rank}${c.suit}`;

function printView(view: TableView): void {
  const pots = view.pots.map((p) => p.amount).join(' + ') || '0';
  console.log(`  board: ${view.board.map(fmt).join(' ') || '(none)'}   pot(s): ${pots}`);
  for (const s of view.seats) {
    const cards =
      s.holeCards === null ? '--'
      : s.holeCards.visibility === 'hidden' ? '?? ??'
      : s.holeCards.cards.map(fmt).join(' ');
    const you = s.seat === view.youSeat ? ' (you)' : '';
    console.log(`  ${s.name}${you}: ${cards}   stack ${s.stack}   ${s.status}`);
  }
  if (view.result) {
    for (const w of view.result.winners) {
      const name = view.seats[w.seat]!.name;
      console.log(`  >> ${name} wins ${w.amount}${w.handDescription ? ` with ${w.handDescription}` : ''}`);
    }
  }
}

function botAction(state: HandState): ClientAction {
  const legal = computeLegalActions(state, state.toAct!)!;
  const r = Math.random();
  if (legal.canRaise && r < 0.08) return { type: 'raise', amount: legal.maxRaiseTo }; // all-in
  if (legal.canRaise && r < 0.18) return { type: 'raise', amount: legal.minRaiseTo };
  if (legal.canCheck) return { type: 'check' };
  if (legal.canCall && r < 0.85) return { type: 'call' };
  return { type: 'fold' };
}

const describeAction = (a: ClientAction) => (a.type === 'raise' ? `raises to ${a.amount}` : `${a.type}s`);

const names = ['Ann', 'Bob', 'Cy', 'Dee'];
const stacks = [150, 400, 1000, 1000];
let state = startHand({
  players: names.map((name, i) => ({ playerId: `p${i}`, name, stack: stacks[i]! })),
  buttonSeat: 0,
  smallBlind: 5,
  bigBlind: 10,
});

function printAllViews(title: string): void {
  console.log(`\n===== ${title} =====`);
  for (const seat of state.seats) {
    console.log(`\nWhat ${seat.name} sees:`);
    printView(toTableView(state, seat.playerId));
  }
}

printAllViews('After the deal');

let lastPhase = state.phase;
while (state.phase !== 'complete') {
  const seat = state.seats[state.toAct!]!;
  const action = botAction(state);
  const r = applyAction(state, seat.playerId, action);
  if (!r.ok) throw new Error(`${seat.name} ${action.type} rejected: ${r.error}`);
  console.log(`${seat.name} ${describeAction(action)}`);
  state = r.state;
  if (state.phase !== lastPhase && state.phase !== 'complete') {
    lastPhase = state.phase;
    console.log(`--- ${state.phase}: board ${state.board.map(fmt).join(' ')}`);
  }
}

printAllViews('Hand complete');