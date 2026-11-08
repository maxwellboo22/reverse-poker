import type { Card, HandPhase, SeatStatus } from '@reverse-poker/shared';
import type { HandRank } from './evaluator';

export type PlayerId = string;

/** SERVER-ONLY. Never sent to clients. */
export interface SeatState {
  seat: number;
  playerId: PlayerId;
  name: string;
  stack: number;
  committedThisRound: number;
  committedThisHand: number;
  status: SeatStatus;
  hasActedThisRound: boolean;
  holeCards: [Card, Card] | null; // SECRET
}

export interface Pot {
  amount: number;
  eligibleSeats: number[];
}

/** The betting round exactly as it was just before the latest bet or raise. */
export interface RaiseSnapshot {
  seat: number; // who made the bet or raise
  currentBet: number;
  lastRaiseSize: number;
  seats: { committedThisRound: number; hasActedThisRound: boolean; status: SeatStatus }[];
}

export interface HandResult {
  /** Chips won from contested pots (or from everyone folding). */
  winners: { seat: number; amount: number; rank: HandRank | null }[];
  /** Uncalled bets handed back. This is NOT winnings. */
  refunds: { seat: number; amount: number }[];
  showdown: boolean; // false if everyone else folded
}

/** SERVER-ONLY authoritative state. */
export interface HandState {
  handId: string;
  version: number;
  phase: HandPhase;
  deck: Card[]; // SECRET. Cards are drawn from the END of this array.
  board: Card[];
  seats: SeatState[];
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  toAct: number | null;
  currentBet: number;
  lastRaiseSize: number;
  lastRaise: RaiseSnapshot | null; // lets a leaver's bet be undone
  minRaise: number; // smallest raise increment at the start of each betting round
  bettingRounds: number; // 1 to 4
  wrapAroundStraights: boolean;
  pots: Pot[];
  result: HandResult | null;
}

export type ActionError =
  | 'hand_over'
  | 'not_seated'
  | 'not_your_turn'
  | 'illegal_check'
  | 'illegal_call'
  | 'illegal_raise';

export type ActionResult =
  | { ok: true; state: HandState }
  | { ok: false; error: ActionError };