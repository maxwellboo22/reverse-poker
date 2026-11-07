import type { Card, HandResultView, HoleCardsView, TableView } from '@reverse-poker/shared';
import { computeLegalActions } from './betting';
import { describeRank } from './evaluator';
import type { HandState, PlayerId, SeatState } from './types';

export interface RevealPolicy {
  /** When a hand completes, show players their own cards. */
  revealOwnCardsAfterHand: boolean;
}

export const DEFAULT_REVEAL_POLICY: RevealPolicy = { revealOwnCardsAfterHand: true };

export interface ViewContext {
  roomCode: string;
  turnDeadline: number | null;
  isConnected: (playerId: PlayerId) => boolean;
  policy: RevealPolicy;
}

// Copy cards so the view never shares objects with server state.
const pub = (c: Card): Card => ({ rank: c.rank, suit: c.suit });

function holeCardsView(seat: SeatState, viewerId: PlayerId, revealOwn: boolean): HoleCardsView | null {
  if (seat.holeCards === null) return null;
  if (seat.playerId === viewerId && !revealOwn) return { visibility: 'hidden', count: 2 };
  const [a, b] = seat.holeCards;
  return { visibility: 'visible', cards: [pub(a), pub(b)] };
}

function resultView(hand: HandState, viewerSeat: number, revealOwn: boolean): HandResultView | null {
  if (!hand.result) return null;
  return {
    winners: hand.result.winners.map((w) => {
      // Never describe the viewer's own hand while their cards are still hidden.
      if (w.rank === null || (w.seat === viewerSeat && !revealOwn)) {
        return { seat: w.seat, amount: w.amount };
      }
      return { seat: w.seat, amount: w.amount, handDescription: describeRank(w.rank) };
    }),
  };
}

/**
 * The ONLY function that turns server state into something a client may see.
 * Everything is listed explicitly (allowlist), so new server-only fields stay hidden.
 */
export function toTableView(
  hand: HandState,
  viewerId: PlayerId,
  ctx: Partial<ViewContext> = {},
): TableView {
  const c: ViewContext = {
    roomCode: 'LOCAL',
    turnDeadline: null,
    isConnected: () => true,
    policy: DEFAULT_REVEAL_POLICY,
    ...ctx,
  };

  const me = hand.seats.find((s) => s.playerId === viewerId);
  if (!me) throw new Error('viewer is not seated at this table');

  const revealOwn = hand.phase === 'complete' && c.policy.revealOwnCardsAfterHand;

  return {
    roomCode: c.roomCode,
    version: hand.version,
    phase: hand.phase,
    youSeat: me.seat,
    board: hand.board.map(pub),
    pots: hand.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })),
    seats: hand.seats.map((s) => ({
      seat: s.seat,
      playerId: s.playerId,
      name: s.name,
      stack: s.stack,
      committedThisRound: s.committedThisRound,
      status: s.status,
      connection: c.isConnected(s.playerId) ? 'connected' : 'disconnected',
      holeCards: holeCardsView(s, viewerId, revealOwn),
    })),
    toAct: hand.toAct,
    turnDeadline: c.turnDeadline,
    legalActions: computeLegalActions(hand, me.seat),
    result: resultView(hand, me.seat, revealOwn),
  };
}