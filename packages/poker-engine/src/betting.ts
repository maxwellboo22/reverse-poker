import type { LegalActions } from '@reverse-poker/shared';
import type { HandState } from './types';

export function minRaiseTo(hand: HandState): number {
  return hand.currentBet + hand.lastRaiseSize;
}

/**
 * Milestone 1 rule: nobody may be forced all-in, so the highest legal
 * raise-to leaves every live player with at least 1 chip.
 */
export function maxRaiseTo(hand: HandState): number {
  let cap = Infinity;
  for (const s of hand.seats) {
    if (s.status !== 'folded') cap = Math.min(cap, s.committedThisRound + s.stack - 1);
  }
  return cap;
}

export function computeLegalActions(hand: HandState, seatIndex: number): LegalActions | null {
  if (hand.phase === 'complete' || hand.toAct !== seatIndex) return null;
  const seat = hand.seats[seatIndex]!;
  const toCall = hand.currentBet - seat.committedThisRound;
  const min = minRaiseTo(hand);
  const max = maxRaiseTo(hand);
  return {
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0 && toCall < seat.stack,
    callAmount: toCall,
    canRaise: min <= max,
    minRaiseTo: min,
    maxRaiseTo: max,
  };
}