import type { Card, Rank, Suit } from '@reverse-poker/shared';
import type { HandCategory, HandRank } from '@reverse-poker/poker-engine';

export const MAX_HOUSE_RULES = 20;
export const MAX_EFFECTS_PER_RULE = 6;
export const MAX_PLAYER_CHIPS = 1_000_000_000;

// ---------- the rule model ----------

export type SuitMode = 'suited' | 'offsuit' | 'any';
export type Trigger = 'win' | 'lose' | 'fold' | 'allin' | 'play';
export type TriggerWho = { kind: 'anyone' } | { kind: 'players'; playerIds: string[] };

export interface CardMatch {
  rank?: Rank;
  suit?: Suit;
  color?: 'red' | 'black';
  minRank?: Rank;
  maxRank?: Rank;
}

export type Compare = '>' | '>=' | '<' | '<=' | '=';
export type Stat = 'pot' | 'chips' | 'bet' | 'players';

export type Condition =
  | { kind: 'hole'; high: Rank; low: Rank; suited: SuitMode }
  | { kind: 'pocketPair' }
  | { kind: 'shape'; suited: boolean | null; connected: boolean }
  | { kind: 'cards'; match: CardMatch; count: number } // at least `count` hole cards match
  | { kind: 'board'; match: CardMatch; count: number }
  | { kind: 'category'; category: HandCategory; royal: boolean; orBetter: boolean; rank: Rank | null }
  | { kind: 'showdown'; value: boolean }
  | { kind: 'stat'; stat: Stat; op: Compare; value: number }
  | { kind: 'not'; inner: Condition }
  | { kind: 'and'; parts: Condition[] }
  | { kind: 'or'; parts: Condition[] };

/** "subject" is whoever triggered the rule (the winner, the loser, the folder, ...). */
export type Party =
  | { kind: 'subject' }
  | { kind: 'everyone' }
  | { kind: 'others' } // everyone except the subject
  | { kind: 'players'; playerIds: string[]; withSubject?: boolean };

export type AmountBase = { kind: 'pot' } | { kind: 'own' } | { kind: 'chipsOf'; party: Party };
export type Amount = { kind: 'fixed'; n: number } | { kind: 'percent'; pct: number; of: AmountBase };

export type Effect =
  | { kind: 'transfer'; from: Party; to: Party; amount: Amount }
  | { kind: 'gain'; to: Party; amount: Amount } // chips from the bank
  | { kind: 'lose'; from: Party; amount: Amount } // chips to the bank
  | { kind: 'set'; target: Party; chips: number };

export interface Rule {
  trigger: Trigger;
  who: TriggerWho;
  cond: Condition | null;
  effects: Effect[];
}

export interface SeatOutcome {
  playerId: string;
  holeCards: readonly [Card, Card];
  won: number; // chips won from pots (refunds don't count)
  folded: boolean;
  allIn: boolean;
  rank: HandRank | null; // only at a showdown, and never for folded players
  bet: number;
}

export interface HandSummary {
  seats: SeatOutcome[];
  board: readonly Card[];
  showdown: boolean;
  pot: number; // chips paid out as winnings
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

export interface MatchContext {
  seat: SeatOutcome;
  summary: HandSummary;
  chips: number; // the seat's chips right now
}

// ---------- matching ----------

export function cardMatches(m: CardMatch, c: Card): boolean {
  if (m.rank !== undefined && c.rank !== m.rank) return false;
  if (m.suit !== undefined && c.suit !== m.suit) return false;
  if (m.color !== undefined && (m.color === 'red') !== (c.suit === 'H' || c.suit === 'D')) return false;
  if (m.minRank !== undefined && c.rank < m.minRank) return false;
  if (m.maxRank !== undefined && c.rank > m.maxRank) return false;
  return true;
}

const countMatches = (list: readonly Card[], m: CardMatch) => list.filter((c) => cardMatches(m, c)).length;

function compare(op: Compare, a: number, b: number): boolean {
  switch (op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '=': return a === b;
  }
}

export function condMatches(c: Condition, x: MatchContext): boolean {
  const [a, b] = x.seat.holeCards;
  switch (c.kind) {
    case 'hole': {
      const high = Math.max(a.rank, b.rank);
      const low = Math.min(a.rank, b.rank);
      if (high !== c.high || low !== c.low) return false;
      if (c.high === c.low) return true;
      return c.suited === 'any' || (c.suited === 'suited') === (a.suit === b.suit);
    }
    case 'pocketPair':
      return a.rank === b.rank;
    case 'shape': {
      if (c.suited !== null && (a.suit === b.suit) !== c.suited) return false;
      if (c.connected) {
        const d = Math.abs(a.rank - b.rank);
        if (d !== 1 && d !== 12) return false; // 12 = ace and two
      }
      return true;
    }
    case 'cards':
      return countMatches([a, b], c.match) >= c.count;
    case 'board':
      return countMatches(x.summary.board, c.match) >= c.count;
    case 'category': {
      const r = x.seat.rank; // needs a showdown
      if (!r) return false;
      if (c.royal) return r.category === 8 && r.tiebreak[0] === 14;
      if (c.rank !== null && r.tiebreak[0] !== c.rank) return false;
      return c.orBetter ? r.category >= c.category : r.category === c.category;
    }
    case 'showdown':
      return x.summary.showdown === c.value;
    case 'stat': {
      const v =
        c.stat === 'pot' ? x.summary.pot
        : c.stat === 'chips' ? x.chips
        : c.stat === 'bet' ? x.seat.bet
        : x.summary.seats.length;
      return compare(c.op, v, c.value);
    }
    case 'not':
      return !condMatches(c.inner, x);
    case 'and':
      return c.parts.every((p) => condMatches(p, x));
    case 'or':
      return c.parts.some((p) => condMatches(p, x));
  }
}

export function triggerHits(t: Trigger, s: SeatOutcome): boolean {
  switch (t) {
    case 'win': return s.won > 0;
    case 'lose': return s.won === 0; // includes folding
    case 'fold': return s.folded;
    case 'allin': return s.allIn;
    case 'play': return true;
  }
}

// ---------- describing ----------

type Label = (playerId: string) => string;

const CATEGORY_TEXT = [
  'a high card', 'a pair', 'two pair', 'three of a kind', 'a straight',
  'a flush', 'a full house', 'four of a kind', 'a straight flush',
] as const;
const RANK_NAME: Record<number, string> = {
  14: 'ace', 13: 'king', 12: 'queen', 11: 'jack', 10: 'ten', 9: 'nine', 8: 'eight',
  7: 'seven', 6: 'six', 5: 'five', 4: 'four', 3: 'three', 2: 'two',
};
const RANK_PLURAL: Record<number, string> = {
  14: 'aces', 13: 'kings', 12: 'queens', 11: 'jacks', 10: 'tens', 9: 'nines', 8: 'eights',
  7: 'sevens', 6: 'sixes', 5: 'fives', 4: 'fours', 3: 'threes', 2: 'twos',
};
const SUIT_NAME: Record<Suit, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const SUIT_ONE: Record<Suit, string> = { S: 'spade', H: 'heart', D: 'diamond', C: 'club' };
const NUMBER_WORD = ['zero', 'one', 'two', 'three', 'four', 'five'];
const OP_TEXT: Record<Compare, string> = {
  '>': 'more than', '>=': 'at least', '<': 'less than', '<=': 'at most', '=': 'exactly',
};
const VERB: Record<Trigger, string> = {
  win: 'wins', lose: 'loses', fold: 'folds', allin: 'goes all in', play: 'plays',
};
const PAST: Record<Trigger, string> = {
  win: 'won', lose: 'lost', fold: 'folded', allin: 'went all in', play: 'played',
};
const SUBJECT_LABEL: Record<Trigger, string> = {
  win: 'the winner', lose: 'the loser', fold: 'the player who folded',
  allin: 'the player who went all in', play: 'the player',
};

const rankName = (r: number) => RANK_NAME[r] ?? String(r);
const rankPlural = (r: number) => RANK_PLURAL[r] ?? `${r}s`;
const rankLabel = (r: number) => (r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : String(r));
const article = (noun: string) => (/^[aeiou]/i.test(noun) ? 'an' : 'a');
const pctText = (n: number) => `${Number.isInteger(n) ? n : Math.round(n * 100) / 100}%`;

export const chipsText = (n: number) => `${n.toLocaleString('en-US')} chip${n === 1 ? '' : 's'}`;

function listWith(names: string[], word: string): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`;
}

function matchNoun(m: CardMatch, plural: boolean): string {
  if (m.rank !== undefined && m.suit !== undefined) {
    return `${plural ? rankPlural(m.rank) : rankName(m.rank)} of ${SUIT_NAME[m.suit]}`;
  }
  if (m.rank !== undefined) return plural ? rankPlural(m.rank) : rankName(m.rank);
  if (m.suit !== undefined) return plural ? SUIT_NAME[m.suit] : SUIT_ONE[m.suit];
  if (m.color !== undefined) return `${m.color} ${plural ? 'cards' : 'card'}`;
  const card = plural ? 'cards' : 'card';
  if (m.minRank === 11 && m.maxRank === 13) return `face ${card}`;
  if (m.minRank !== undefined && m.maxRank !== undefined) {
    return `${card} from ${rankName(m.minRank)} to ${rankName(m.maxRank)}`;
  }
  if (m.minRank !== undefined) return `${card} ${rankName(m.minRank)} or higher`;
  if (m.maxRank !== undefined) return `${card} ${rankName(m.maxRank)} or lower`;
  return card;
}

function describeMatch(m: CardMatch, count: number): string {
  if (count <= 1) {
    const noun = matchNoun(m, false);
    return m.rank !== undefined && m.suit !== undefined ? `the ${noun}` : `${article(noun)} ${noun}`;
  }
  return `${NUMBER_WORD[count] ?? count} ${matchNoun(m, true)}`;
}

function isHandish(c: Condition): boolean {
  switch (c.kind) {
    case 'hole': case 'pocketPair': case 'shape': case 'cards': case 'category': return true;
    case 'and': case 'or': return c.parts.every(isHandish);
    default: return false;
  }
}

function firstLeaf(c: Condition): Condition {
  return c.kind === 'and' || c.kind === 'or' ? firstLeaf(c.parts[0]!) : c;
}

function describeCond(c: Condition): string {
  switch (c.kind) {
    case 'hole':
      return c.high === c.low
        ? `pocket ${rankPlural(c.high)}`
        : `${rankLabel(c.high)}-${rankLabel(c.low)} ${c.suited === 'any' ? '(any suits)' : c.suited}`;
    case 'pocketPair':
      return 'a pocket pair';
    case 'shape': {
      const suit = c.suited === null ? '' : c.suited ? 'suited ' : 'offsuit ';
      return `${suit}${c.connected ? 'connectors' : 'cards'}`;
    }
    case 'cards':
      return describeMatch(c.match, c.count);
    case 'board':
      return `the board has ${describeMatch(c.match, c.count)}`;
    case 'category': {
      if (c.royal) return 'a royal flush';
      if (c.category === 0 && c.rank !== null) return `${rankName(c.rank)} high`;
      const base = CATEGORY_TEXT[c.category];
      if (c.orBetter) return `${base} or better`;
      if (c.rank !== null) return `${base} of ${rankPlural(c.rank)}`;
      return base;
    }
    case 'showdown':
      return c.value ? 'there is a showdown' : 'everyone else folds';
    case 'stat': {
      const op = OP_TEXT[c.op];
      const n = c.value.toLocaleString('en-US');
      if (c.stat === 'pot') return `the pot is ${op} ${n}`;
      if (c.stat === 'chips') return `they have ${op} ${n} chips`;
      if (c.stat === 'bet') return `they bet ${op} ${n}`;
      return `there are ${op} ${n} players`;
    }
    case 'not':
      return `not ${c.inner.kind === 'and' || c.inner.kind === 'or' ? `(${describeCond(c.inner)})` : describeCond(c.inner)}`;
    case 'and':
      return c.parts.map((p) => (p.kind === 'or' ? `(${describeCond(p)})` : describeCond(p))).join(' and ');
    case 'or':
      return c.parts.map(describeCond).join(' or ');
  }
}

export const describeCondition = describeCond;

function conditionPart(cond: Condition | null): string {
  if (!cond) return '';
  if (cond.kind === 'not' && isHandish(cond.inner)) return ` without ${describeCond(cond.inner)}`;
  return ` ${isHandish(firstLeaf(cond)) ? 'with' : 'when'} ${describeCond(cond)}`;
}

const isGroup = (p: Party) => p.kind === 'everyone' || p.kind === 'others';
const partyCount = (p: Party) => (p.kind === 'players' ? p.playerIds.length + (p.withSubject ? 1 : 0) : 1);
const isMany = (p: Party) => isGroup(p) || partyCount(p) > 1;

function partyText(p: Party, subj: string, label: Label, everyoneElse = false): string {
  switch (p.kind) {
    case 'subject': return subj;
    case 'everyone': return everyoneElse ? 'everyone else' : 'everyone';
    case 'others': return 'everyone else';
    case 'players': {
      const names = p.playerIds.map(label);
      if (p.withSubject) names.unshift(subj);
      return listWith(names, 'and');
    }
  }
}

function amountText(a: Amount, subj: string, label: Label): string {
  if (a.kind === 'fixed') return chipsText(a.n);
  const base =
    a.of.kind === 'pot' ? 'the pot'
    : a.of.kind === 'own' ? 'their chips'
    : `${partyText(a.of.party, subj, label)}'s chips`;
  if (a.pct === 100) return `all of ${base}`;
  if (a.pct === 50) return `half of ${base}`;
  return `${pctText(a.pct)} of ${base}`;
}

function effectText(e: Effect, subj: string, label: Label): string {
  switch (e.kind) {
    case 'transfer': {
      const each = e.amount.kind === 'fixed' && (isMany(e.from) || isMany(e.to)) ? ' each' : '';
      const verb = !isGroup(e.from) && partyCount(e.from) > 1 ? 'pay' : 'pays';
      return `${partyText(e.from, subj, label, true)} ${verb} ${partyText(e.to, subj, label, true)} ${amountText(e.amount, subj, label)}${each}`;
    }
    case 'gain': {
      const each = e.amount.kind === 'fixed' && isMany(e.to) ? ' each' : '';
      const verb = !isGroup(e.to) && partyCount(e.to) > 1 ? 'get' : 'gets';
      return `${partyText(e.to, subj, label)} ${verb} ${amountText(e.amount, subj, label)}${each}`;
    }
    case 'lose': {
      const each = e.amount.kind === 'fixed' && isMany(e.from) ? ' each' : '';
      const verb = !isGroup(e.from) && partyCount(e.from) > 1 ? 'lose' : 'loses';
      return `${partyText(e.from, subj, label)} ${verb} ${amountText(e.amount, subj, label)}${each}`;
    }
    case 'set': {
      const verb = !isGroup(e.target) && partyCount(e.target) > 1 ? 'are' : 'is';
      return `${partyText(e.target, subj, label)} ${verb} set to ${chipsText(e.chips)}`;
    }
  }
}

// ---------- who a rule mentions ----------

const partyIds = (p: Party) => (p.kind === 'players' ? p.playerIds : []);
const amountIds = (a: Amount) => (a.kind === 'percent' && a.of.kind === 'chipsOf' ? partyIds(a.of.party) : []);

export function ruleReferencedIds(rule: Rule): string[] {
  const ids = rule.who.kind === 'players' ? [...rule.who.playerIds] : [];
  for (const e of rule.effects) {
    switch (e.kind) {
      case 'transfer': ids.push(...partyIds(e.from), ...partyIds(e.to), ...amountIds(e.amount)); break;
      case 'gain': ids.push(...partyIds(e.to), ...amountIds(e.amount)); break;
      case 'lose': ids.push(...partyIds(e.from), ...amountIds(e.amount)); break;
      case 'set': ids.push(...partyIds(e.target)); break;
    }
  }
  return ids;
}

export function describeRule(
  rule: Rule,
  nameOf: (playerId: string) => string | null,
): { text: string; active: boolean } {
  const label: Label = (id) => nameOf(id) ?? 'a player who left';
  const active = ruleReferencedIds(rule).every((id) => nameOf(id) !== null);
  const who = rule.who.kind === 'anyone' ? 'someone' : listWith(rule.who.playerIds.map(label), 'or');
  const subj = SUBJECT_LABEL[rule.trigger];
  const effects = rule.effects.map((e) => effectText(e, subj, label)).join('; ');
  return { text: `If ${who} ${VERB[rule.trigger]}${conditionPart(rule.cond)}: ${effects}.`, active };
}

// ---------- applying ----------

interface Entry {
  text: string;
  moved: boolean; // chips actually changed
  short: boolean; // someone couldn't pay in full
}

/**
 * Runs every rule against the finished hand. Pure: returns the new chip counts
 * and the chat lines to announce. Rules run in order, and later rules see the
 * chips left by earlier ones. NOTE: announcements can name the winner's cards.
 * That is safe only because players are shown their own cards when a hand
 * completes (the default reveal policy).
 */
export function evaluateRules(
  rules: readonly Rule[],
  summary: HandSummary,
  players: readonly PlayerChips[],
): RuleOutcome {
  const before = new Map<string, number>(players.map((p) => [p.id, p.chips] as const));
  const chips = new Map<string, number>(before);
  const names = new Map<string, string>(players.map((p) => [p.id, p.name] as const));
  const order = players.map((p) => p.id);
  const label: Label = (id) => names.get(id) ?? 'a player who left';
  const lines: string[] = [];

  const resolve = (party: Party, subjectId: string): string[] => {
    switch (party.kind) {
      case 'subject': return [subjectId];
      case 'everyone': return [...order];
      case 'others': return order.filter((id) => id !== subjectId);
      case 'players': {
        const ids = party.playerIds.filter((id) => names.has(id));
        if (party.withSubject && !ids.includes(subjectId)) ids.push(subjectId);
        return ids;
      }
    }
  };

  const amountFor = (a: Amount, ownId: string | null, subjectId: string): number => {
    if (a.kind === 'fixed') return a.n;
    let base = 0;
    switch (a.of.kind) {
      case 'pot':
        base = summary.pot;
        break;
      case 'own':
        base = ownId ? (chips.get(ownId) ?? 0) : 0;
        break;
      case 'chipsOf':
        base = resolve(a.of.party, subjectId).reduce((sum, id) => sum + (chips.get(id) ?? 0), 0);
        break;
    }
    return Math.max(0, Math.floor((base * a.pct) / 100 + 1e-9));
  };

  const apply = (effect: Effect, subjectId: string): Entry[] => {
    const out: Entry[] = [];
    switch (effect.kind) {
      case 'transfer':
        for (const from of resolve(effect.from, subjectId)) {
          const requested = amountFor(effect.amount, from, subjectId);
          if (requested <= 0) continue;
          for (const to of resolve(effect.to, subjectId)) {
            if (from === to) continue;
            const have = chips.get(from) ?? 0;
            const room = MAX_PLAYER_CHIPS - (chips.get(to) ?? 0);
            const paid = Math.max(0, Math.min(requested, have, room));
            if (paid > 0) {
              chips.set(from, have - paid);
              chips.set(to, (chips.get(to) ?? 0) + paid);
            }
            out.push({
              text: `${label(from)} pays ${label(to)} ${paid}`,
              moved: paid > 0,
              short: paid < requested,
            });
          }
        }
        break;
      case 'gain':
        for (const to of resolve(effect.to, subjectId)) {
          const requested = amountFor(effect.amount, to, subjectId);
          if (requested <= 0) continue;
          const have = chips.get(to) ?? 0;
          const gained = Math.max(0, Math.min(requested, MAX_PLAYER_CHIPS - have));
          if (gained > 0) chips.set(to, have + gained);
          out.push({ text: `${label(to)} gets ${gained}`, moved: gained > 0, short: false });
        }
        break;
      case 'lose':
        for (const from of resolve(effect.from, subjectId)) {
          const requested = amountFor(effect.amount, from, subjectId);
          if (requested <= 0) continue;
          const have = chips.get(from) ?? 0;
          const lost = Math.min(requested, have);
          if (lost > 0) chips.set(from, have - lost);
          out.push({ text: `${label(from)} loses ${lost}`, moved: lost > 0, short: lost < requested });
        }
        break;
      case 'set':
        for (const target of resolve(effect.target, subjectId)) {
          const old = chips.get(target) ?? 0;
          const now = Math.min(effect.chips, MAX_PLAYER_CHIPS);
          chips.set(target, now);
          out.push({ text: `${label(target)} now has ${now}`, moved: old !== now, short: false });
        }
        break;
    }
    return out;
  };

  rules.forEach((rule, index) => {
    // A rule that names someone who has left is skipped.
    if (!ruleReferencedIds(rule).every((id) => names.has(id))) return;

    for (const seat of summary.seats) {
      if (!names.has(seat.playerId)) continue;
      if (rule.who.kind === 'players' && !rule.who.playerIds.includes(seat.playerId)) continue;
      if (!triggerHits(rule.trigger, seat)) continue;
      if (rule.cond && !condMatches(rule.cond, { seat, summary, chips: chips.get(seat.playerId) ?? 0 })) {
        continue;
      }

      const entries = rule.effects.flatMap((e) => apply(e, seat.playerId));
      if (entries.length === 0) continue;

      const heading = `Rule ${index + 1} triggered: ${label(seat.playerId)} ${PAST[rule.trigger]}${conditionPart(rule.cond)}.`;
      const moved = entries.filter((e) => e.moved);
      if (moved.length === 0) {
        lines.push(`${heading} ${entries.some((e) => e.short) ? 'Nobody had chips to pay.' : 'Nothing changed.'}`);
        continue;
      }
      const shown = moved.slice(0, 8).map((e) => e.text).join(', ');
      const more = moved.length > 8 ? ` …and ${moved.length - 8} more` : '';
      const short = entries.some((e) => e.short) ? " (someone couldn't pay in full)" : '';
      lines.push(`${heading} ${shown}${more}${short}.`);
    }
  });

  let changed = false;
  for (const [id, c] of chips) if (before.get(id) !== c) changed = true;
  return { chips, lines, changed };
}