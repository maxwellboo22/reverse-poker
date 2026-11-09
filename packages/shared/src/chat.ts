import { z } from 'zod';

export const MAX_CHAT_LENGTH = 300;
export const MAX_CHAT_HISTORY = 100;

export const ChatSendSchema = z.object({
  text: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(MAX_CHAT_LENGTH).regex(/^[^\p{C}]+$/u)),
});

export interface ChatMessage {
  id: number;
  kind: 'user' | 'system';
  name: string; // empty for system messages
  text: string;
}

/** A private answer to a command (errors, /help, /rules). Only the sender sees it. */
export interface ChatReply {
  ok: boolean;
  text: string;
}

/** A special rule, as everyone in the room sees it. */
export interface RuleView {
  number: number;
  text: string;
  /** false when a player named in the rule has left the room. */
  active: boolean;
}

export function rulesSummary(s: {
  smallBlind: number;
  bigBlind: number;
  minRaise: number;
  bettingRounds: number;
  wrapAroundStraights: boolean;
}): string {
  const rounds = `${s.bettingRounds} betting round${s.bettingRounds === 1 ? '' : 's'}`;
  return `blinds ${s.smallBlind}/${s.bigBlind} · min raise ${s.minRaise} · ${rounds} · wrap-around straights ${
    s.wrapAroundStraights ? 'on' : 'off'
  }`;
}