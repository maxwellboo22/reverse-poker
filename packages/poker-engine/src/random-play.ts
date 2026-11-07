import type { ClientAction } from '@reverse-poker/shared';
import { computeLegalActions } from './betting';
import type { HandState } from './types';

/** Picks a legal action from two arbitrary integers. For tests only. */
export function pickAction(state: HandState, a: number, b: number): ClientAction {
  const legal = computeLegalActions(state, state.toAct!)!;
  const options: ClientAction[] = [{ type: 'fold' }];
  if (legal.canCheck) options.push({ type: 'check' });
  if (legal.canCall) options.push({ type: 'call' });
  if (legal.canRaise) {
    const span = legal.maxRaiseTo - legal.minRaiseTo + 1;
    options.push({ type: 'raise', amount: legal.minRaiseTo + (b % span) });
  }
  return options[a % options.length]!;
}