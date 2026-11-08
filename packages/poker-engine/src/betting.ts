import type { LegalActions } from '@reverse-poker/shared';
import type { HandState } from './types';

export function computeLegalActions(hand: HandState, seatIndex: number): LegalActions | null {
  if (hand.phase === 'complete' || hand.toAct !== seatIndex) return null;
  const seat = hand.seats[seatIndex]!;
  const toCall = hand.currentBet - seat.committedThisRound;
  const allInTo = seat.committedThisRound + seat.stack;

  // Raising is pointless if nobody else can act, and not allowed if you've
  // already acted and nobody has made a full raise since.
  const othersCanAct = hand.seats.some((o) => o.seat !== seat.seat && o.status === 'active');
  const canRaise = othersCanAct && !seat.hasActedThisRound && allInTo > hand.currentBet;

  return {
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount: Math.min(toCall, seat.stack),
    canRaise,
    // A raise below the minimum is only legal if it puts you all-in.
    minRaiseTo: Math.min(hand.currentBet + hand.lastRaiseSize, allInTo),
    maxRaiseTo: allInTo,
  };
}