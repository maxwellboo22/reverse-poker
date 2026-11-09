import type { Card, Rank } from '@reverse-poker/shared';
import type { HandCategory, HandRank } from '@reverse-poker/poker-engine';

export const MAX_HOUSE_RULES = 20;

export type SuitMode = 'suited' | 'offsuit' | 'any';

export type HandPattern =
  | { kind: 'hole'; high: Rank; low: Rank; suited: SuitMode } // high === low means a pocket pair
  | { kind: 'pocketPair' }
  | { kind: 'category'; category: HandCategory; royal: boolean };

export type Party =
  | { kind: 'winner' }
  | { kind: 'everyone' }
  | { kind: 'player'; playerId: string };

export type TriggerWho = { kind: 'anyone' } | { kind: 'player'; playerId: string };

export interface Effect {
  from: Party;
  to: Party;
  amount: number; // per person when one side is "everyone"
}

export interface Rule {
  who: TriggerWho;
  hand: HandPattern | null;
  effect: Effect;
}

export interface WinnerInfo {
  playerId: string;
  holeCards: readonly [Card, Card];
  /** null when the hand ended without a showdown. */
  rank: HandRank | null;
}

export interface PlayerChips {
  id: string;
  name: string;
  chips: number;
}

export interface RuleOutcome {
  chips: Map<string, number>;
  lines: string[];
  changed: boolean;
}

// ---------- describing ----------

const CATEGORY_TEXT = [
  'high card', 'a pair', 'two pair', 'three of a kind', 'a straight',
  'a flush', 'a full house', 'four of a kind', 'a straight flush',
] as const;

const PLURAL: Record<number, string> = { 14: 'aces', 13: 'kings', 12: 'queens', 11: 'jacks', 10: 'tens' };

function rankLabel(r: number): string {
  if (r === 14) return 'A';
  if (r === 13) return 'K';
  if (r === 12) return 'Q';
  if (r === 11) return 'J';
  return String(r);
}

const chipsText = (n: number) => `${n.toLocaleString('en-US')} chip${n === 1 ? '' : 's'}`;

export function describeHand(h: HandPattern): string {
  switch (h.kind) {
    case 'hole':
      if (h.high === h.low) return `pocket ${PLURAL[h.high] ?? `${h.high}s`}`;
      return `${rankLabel(h.high)}-${rankLabel(h.low)} ${h.suited === 'any' ? '(any suits)' : h.suited}`;
    case 'pocketPair':
      return 'a pocket pair';
    case 'category':
      return h.royal ? 'a royal flush' : CATEGORY_TEXT[h.category];
  }
}

function partyLabel(p: Party, label: (id: string) => string): string {
  if (p.kind === 'winner') return 'the winner';
  if (p.kind === 'everyone') return 'everyone';
  return label(p.playerId);
}

export function describeEffect(e: Effect, label: (id: string) => string): string {
  if (e.from.kind === 'everyone') {
    return `everyone else pays ${partyLabel(e.to, label)} ${chipsText(e.amount)} each`;
  }
  if (e.to.kind === 'everyone') {
    return `${partyLabel(e.from, label)} pays everyone else ${chipsText(e.amount)} each`;
  }
  return `${partyLabel(e.from, label)} pays ${partyLabel(e.to, label)} ${chipsText(e.amount)}`;
}

export function ruleReferencedIds(rule: Rule): string[] {
  const ids: string[] = [];
  if (rule.who.kind === 'player') ids.push(rule.who.playerId);
  for (const p of [rule.effect.from, rule.effect.to]) {
    if (p.kind === 'player') ids.push(p.playerId);
  }
  return ids;
}

export function describeRule(
  rule: Rule,
  nameOf: (playerId: string) => string | null,
): { text: string; active: boolean } {
  const label = (id: string) => nameOf(id) ?? 'a player who left';
  const active = ruleReferencedIds(rule).every((id) => nameOf(id) !== null);
  const who = rule.who.kind === 'anyone' ? 'someone' : label(rule.who.playerId);
  const hand = rule.hand ? ` with ${describeHand(rule.hand)}` : '';
  return { text: `If ${who} wins${hand}: ${describeEffect(rule.effect, label)}.`, active };
}

// ---------- matching ----------

export function handMatches(pattern: HandPattern, w: WinnerInfo): boolean {
  const [a, b] = w.holeCards;
  switch (pattern.kind) {
    case 'hole': {
      const high = Math.max(a.rank, b.rank);
      const low = Math.min(a.rank, b.rank);
      if (high !== pattern.high || low !== pattern.low) return false;
      if (pattern.high === pattern.low) return true;
      return pattern.suited === 'any' || (pattern.suited === 'suited') === (a.suit === b.suit);
    }
    case 'pocketPair':
      return a.rank === b.rank;
    case 'category':
      // Needs a showdown rank, so these never fire when everyone else folded.
      if (!w.rank || w.rank.category !== pattern.category) return false;
      return pattern.royal ? w.rank.tiebreak[0] === 14 : true;
  }
}

export function triggerMatches(rule: Rule, w: WinnerInfo): boolean {
  if (rule.who.kind === 'player' && rule.who.playerId !== w.playerId) return false;
  return rule.hand === null || handMatches(rule.hand, w);
}

// ---------- applying ----------

interface Transfer {
  from: string;
  to: string;
  requested: number;
  paid: number;
}

function applyEffect(
  effect: Effect,
  winnerId: string,
  order: readonly string[],
  chips: Map<string, number>,
): Transfer[] {
  const single = (p: Party): string | null =>
    p.kind === 'winner' ? winnerId : p.kind === 'player' ? p.playerId : null;
  const fromId = single(effect.from);
  const toId = single(effect.to);
  const transfers: Transfer[] = [];

  const pay = (from: string, to: string) => {
    if (from === to) return;
    const have = chips.get(from) ?? 0;
    const paid = Math.min(effect.amount, have);
    if (paid > 0) {
      chips.set(from, have - paid);
      chips.set(to, (chips.get(to) ?? 0) + paid);
    }
    transfers.push({ from, to, requested: effect.amount, paid });
  };

  if (effect.from.kind === 'everyone' && toId) {
    for (const id of order) pay(id, toId);
  } else if (effect.to.kind === 'everyone' && fromId) {
    for (const id of order) pay(fromId, id);
  } else if (fromId && toId) {
    pay(fromId, toId);
  }
  return transfers;
}

/**
 * Runs every rule against the hand's winners. Pure: returns the new chip
 * counts and the chat lines to announce. NOTE: the announcements name the
 * winner's hole-card pattern. That is safe only because players are shown
 * their own cards when a hand completes (the default reveal policy).
 */
export function evaluateRules(
  rules: readonly Rule[],
  winners: readonly WinnerInfo[],
  players: readonly PlayerChips[],
): RuleOutcome {
  const chips = new Map(players.map((p) => [p.id, p.chips] as const));
  const names = new Map(players.map((p) => [p.id, p.name] as const));
  const order = players.map((p) => p.id);
  const lines: string[] = [];
  let changed = false;

  rules.forEach((rule, index) => {
    // A rule that names someone who has left is skipped.
    if (!ruleReferencedIds(rule).every((id) => names.has(id))) return;

    for (const w of winners) {
      if (!names.has(w.playerId) || !triggerMatches(rule, w)) continue;

      const transfers = applyEffect(rule.effect, w.playerId, order, chips);
      const paid = transfers.filter((t) => t.paid > 0);
      if (paid.length > 0) changed = true;

      const heading = `Rule ${index + 1} triggered: ${names.get(w.playerId)} won${
        rule.hand ? ` with ${describeHand(rule.hand)}` : ''
      }.`;
      if (paid.length === 0) {
        lines.push(`${heading} Nobody had chips to pay.`);
        continue;
      }
      const shown = paid
        .slice(0, 8)
        .map((t) => `${names.get(t.from)} pays ${names.get(t.to)} ${t.paid}`)
        .join(', ');
      const more = paid.length > 8 ? ` …and ${paid.length - 8} more` : '';
      const short = transfers.some((t) => t.paid < t.requested)
        ? " (someone couldn't pay in full)"
        : '';
      lines.push(`${heading} ${shown}${more}${short}.`);
    }
  });

  return { chips, lines, changed };
}