import type { Card } from './cards';

export type HandPhase =
  | 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';
export type SeatStatus = 'active' | 'folded' | 'allIn' | 'sittingOut';

export type HoleCardsView =
  | { visibility: 'hidden'; count: 2 }                 // what you see for yourself
  | { visibility: 'visible'; cards: [Card, Card] };    // what you see for others

export interface SeatView {
  seat: number;
  playerId: string;
  name: string;
  stack: number;
  committedThisRound: number;
  status: SeatStatus;
  connection: 'connected' | 'disconnected';
  holeCards: HoleCardsView | null;                     // null = not dealt
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface HandResultView {
  winners: { seat: number; amount: number; handDescription?: string }[];
}

export interface TableView {
  roomCode: string;
  version: number;
  phase: HandPhase;
  youSeat: number;
  board: Card[];
  pots: { amount: number; eligibleSeats: number[] }[];
  seats: SeatView[];
  toAct: number | null;
  turnDeadline: number | null;
  legalActions: LegalActions | null;                   // only set when it's your turn
  result: HandResultView | null;
}