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

export interface HandResult {
  winners: { seat: number; amount: number; rank: HandRank | null }[];
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