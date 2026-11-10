import { MAX_CHIPS, type Rank, type Suit } from '@reverse-poker/shared';
import type { HandCategory } from '@reverse-poker/poker-engine';
import {
  MAX_EFFECTS_PER_RULE,
  type Amount, type AmountBase, type CardMatch, type Compare, type Condition, type Effect,
  type Party, type Rule, type SuitMode, type Trigger, type TriggerWho,
} from './rules';

export interface PlayerRef {
  id: string;
  name: string;
}

export interface ParseContext {
  /** In room order: "player 1" is the first entry. */
  players: PlayerRef[];
  hostId: string | null;
}

export type Command =
  | { kind: 'help' }
  | { kind: 'listRules' }
  | { kind: 'showSettings' }
  | { kind: 'addRule'; rule: Rule }
  | { kind: 'removeRule'; number: number }
  | { kind: 'clearRules' }
  | { kind: 'kick'; playerId: string }
  /** mode "set": amount is the new total. mode "add": amount is a signed change. */
  | { kind: 'chips'; playerIds: string[]; mode: 'set' | 'add'; amount: number }
  | { kind: 'reset' }
  | { kind: 'setBlinds'; smallBlind: number; bigBlind: number }
  | { kind: 'setMinRaise'; amount: number }
  | { kind: 'setRounds'; rounds: number }
  | { kind: 'setWrap'; on: boolean };

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string };

export const HELP_TEXT = [
  'Type a normal message to chat. Commands start with "/". Only the host can change things.',
  '',
  'SPECIAL RULES:  /rule if <who> <wins|loses|folds|goes all in|plays> [with/when <condition>] then <payout>',
  '  /rule if someone wins with 7 2 offsuit then everyone pays them 10 chips',
  '  /rule every time player 4 wins player 2 gives player 3 10 chips',
  '  /rule if someone folds then they lose 5 chips',
  '  /rule if Bob wins with a flush or better then he gets 50 chips',
  '  /rule if someone wins with the ace of spades and a red card then everyone pays them 5',
  '  /rule if someone is dealt suited connectors then take 10 chips from everyone',
  '  /rule if someone wins when the pot is over 200 then the winner gives Bob half of the pot',
  '  Who: someone, a name, "player 3", Bob or Cara, me.',
  '  Hands: 7 2 offsuit, 72o, AKs, ace king suited, pocket aces, a pocket pair, suited cards,',
  '    suited connectors, a flush, a straight, a full house, four of a kind, three of a kind,',
  '    two pair, a pair, a pair of aces, ace high, a royal flush, a flush or better.',
  '  Cards: the ace of spades, As Kh, 7h, two hearts, a red card, a face card, a ten or higher, an ace.',
  '  Conditions: join with and / or / without / not. Also: at showdown, without a showdown,',
  '    the pot is over 100, they have under 50 chips, they bet more than 20,',
  '    there are at least 3 players, heads up, the board has an ace.',
  '  Payouts: everyone pays them 10 | they get 50 chips | they lose 20 chips | give them 50 chips |',
  '    take 10 chips from everyone | Bob gives Cara 10 | Bob\'s chips are set to 100.',
  '    Amounts: 10, half of the pot, 25% of their chips, all of Bob\'s chips. Join payouts with "and".',
  '  Hand names like "a flush" only count at a showdown.',
  '  /rules (list)    /remove rule 2    /clear rules',
  '',
  'PLAYERS:  /kick Bob    /reset',
  '  /chips Bob 500 (set)    /chips Bob +50    /chips Bob -20    /chips everyone 500',
  '  /give Bob 50    /take Bob 20    /give everyone 100',
  '',
  'GAME:  /blinds 25/50    /minraise 100    /rounds 2    /wrap on|off    /settings',
].join('\n');

class ParseError extends Error {}

// ---------- tiny parsing toolkit ----------

interface Hit<T> {
  value: T;
  rest: string;
}

const END = String.raw`(?![\p{L}\p{N}_])`;
const rx = (source: string) => new RegExp(source, 'iu');

function take(s: string, re: RegExp): { match: RegExpExecArray; rest: string } | null {
  const match = re.exec(s);
  return match ? { match, rest: s.slice(match[0].length).replace(/^\s+/, '') } : null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MAX_STAT = 1_000_000_000;
const NUMBER_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?!\d)/;
const CHIPS_WORD = rx(String.raw`^chips?${END}`);

function chipAmount(text: string, min = 1): number {
  const n = Number(text.replace(/,/g, ''));
  if (!Number.isSafeInteger(n) || n < min || n > MAX_CHIPS) {
    throw new ParseError(
      `Amounts must be whole numbers from ${min} to ${MAX_CHIPS.toLocaleString('en-US')}.`,
    );
  }
  return n;
}

function statNumber(text: string): number {
  const n = Number(text.replace(/,/g, ''));
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_STAT) {
    throw new ParseError(`Numbers in conditions must be whole numbers from 0 to ${MAX_STAT.toLocaleString('en-US')}.`);
  }
  return n;
}

// ---------- ranks and suits ----------

const RANK_WORDS: Record<string, Rank> = {
  two: 2, deuce: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  jack: 11, queen: 12, king: 13, ace: 14,
};
const RANK_LETTERS: Record<string, Rank> = { t: 10, j: 11, q: 12, k: 13, a: 14 };

function rankOf(token: string): Rank {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t) as Rank;
  return (RANK_LETTERS[t] ?? RANK_WORDS[t]) as Rank;
}

const SUIT_LETTERS: Record<string, Suit> = {
  s: 'S', h: 'H', d: 'D', c: 'C', '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C',
};
/** Works for "spades", "s" and "♠". */
const suitFromToken = (token: string): Suit => SUIT_LETTERS[token.charAt(0).toLowerCase()]!;

const RANK_WORD_ALT = String.raw`10|[2-9]|ten|two|three|four|five|six|seven|eight|nine|jack|queen|king|ace|deuce`;
const RANK_ALT = String.raw`${RANK_WORD_ALT}|[tjqka]`;
const SUIT_ALT = String.raw`spades?|hearts?|diamonds?|clubs?`;
const ART = String.raw`(?:an?\s+)?`;
const THE = String.raw`(?:(?:an?|the)\s+)?`;

// ---------- players ----------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const PLAYER_NUMBER = rx(
  String.raw`^(?:player\s+#?|#)(\d+|one|two|three|four|five|six|seven|eight|nine|ten)${END}`,
);
const ME = rx(String.raw`^(?:me|myself|i)${END}`);
const ALL_PLAYERS = rx(String.raw`^(?:every(?:one|body)|all(?:\s+players)?)${END}`);
const LIST_SEP = rx(String.raw`^(?:,\s*(?:and\s+)?|and\s+|&\s*)`);
const WHO_SEP = rx(String.raw`^(?:,\s*(?:or\s+|and\s+)?|or\s+|and\s+|&\s*)`);

function listPlayers(ctx: ParseContext): string {
  return `Players: ${ctx.players.map((p, i) => `${i + 1} ${p.name}`).join(', ')}.`;
}

function hostId(ctx: ParseContext): string {
  if (!ctx.hostId) throw new ParseError('There is no host right now.');
  return ctx.hostId;
}

/** A player by name (longest match first) or as "player 3". */
function parsePlayerRef(s: string, ctx: ParseContext): Hit<string> | null {
  const byLength = [...ctx.players].sort((a, b) => b.name.length - a.name.length);
  for (const p of byLength) {
    const hit = take(s, new RegExp(`^${escapeRegExp(p.name)}(?![\\p{L}\\p{N}_])`, 'iu'));
    if (hit) return { value: p.id, rest: hit.rest };
  }
  const num = take(s, PLAYER_NUMBER);
  if (num) {
    const raw = num.match[1]!.toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]!;
    const player = ctx.players[n - 1];
    if (!player) throw new ParseError(`There is no player ${n}. ${listPlayers(ctx)}`);
    return { value: player.id, rest: num.rest };
  }
  return null;
}

/** A player by name, number, or "me". */
function parsePlayerOrMe(s: string, ctx: ParseContext): Hit<string> | null {
  const ref = parsePlayerRef(s, ctx);
  if (ref) return ref;
  const me = take(s, ME);
  return me ? { value: hostId(ctx), rest: me.rest } : null;
}

// ---------- parties: who pays, who gets ----------

const EVERYONE_ELSE = rx(
  String.raw`^(?:every(?:one|body)\s+else|all\s+(?:the\s+)?other\s+players|all\s+(?:the\s+)?others|(?:the\s+)?other\s+players|the\s+others|the\s+rest(?:\s+of\s+the\s+players)?|each\s+other\s+player)${END}`,
);
const EVERYONE = rx(
  String.raw`^(?:every(?:one|body)|all\s+(?:the\s+)?players|all\s+of\s+(?:them|us)|each\s+player|every\s+player|the\s+table)${END}`,
);
const SUBJECT = rx(
  String.raw`^(?:the\s+(?:winner|loser|folder)|(?:the\s+)?player\s+who\s+(?:won|lost|folded|went\s+all[ -]?in)|that\s+player|this\s+player|whoever\s+(?:won|lost|folded)|them|they|him|her|he|she|the\s+player)${END}`,
);
const VERB_AHEAD = rx(
  String.raw`^(?:pays?|gives?|sends?|hands?|owes?|transfers?|gets?|receives?|collects?|takes?|loses?|forfeits?|gains?|wins?|earns?|is|are|has|have)${END}`,
);

type Item =
  | { kind: 'subject' }
  | { kind: 'everyone' }
  | { kind: 'others' }
  | { kind: 'player'; id: string };

function parseItem(s: string, ctx: ParseContext): Hit<Item> | null {
  const ref = parsePlayerRef(s, ctx);
  if (ref) return { value: { kind: 'player', id: ref.value }, rest: ref.rest };
  const els = take(s, EVERYONE_ELSE);
  if (els) return { value: { kind: 'others' }, rest: els.rest };
  const all = take(s, EVERYONE);
  if (all) return { value: { kind: 'everyone' }, rest: all.rest };
  const me = take(s, ME);
  if (me) return { value: { kind: 'player', id: hostId(ctx) }, rest: me.rest };
  const subject = take(s, SUBJECT);
  if (subject) return { value: { kind: 'subject' }, rest: subject.rest };
  return null;
}

/**
 * A group of players. `target` is true after a verb ("pays Dan and Eve"): there, a name that
 * is followed by a new verb ("... and Eve gets 5") starts the next payout instead.
 */
function parseParty(s: string, ctx: ParseContext, target: boolean): Hit<Party> | null {
  const first = parseItem(s, ctx);
  if (!first) return null;
  if (first.value.kind === 'everyone') return { value: { kind: 'everyone' }, rest: first.rest };
  if (first.value.kind === 'others') return { value: { kind: 'others' }, rest: first.rest };

  const ids: string[] = [];
  let withSubject = false;
  const add = (i: Item) => {
    if (i.kind === 'subject') withSubject = true;
    else if (i.kind === 'player' && !ids.includes(i.id)) ids.push(i.id);
  };
  add(first.value);
  let rest = first.rest;
  for (;;) {
    const sep = take(rest, LIST_SEP);
    if (!sep) break;
    const next = parseItem(sep.rest, ctx);
    if (!next || next.value.kind === 'everyone' || next.value.kind === 'others') break;
    if (target && VERB_AHEAD.test(next.rest)) break;
    add(next.value);
    rest = next.rest;
  }
  if (ids.length === 0) return { value: { kind: 'subject' }, rest };
  return {
    value: withSubject ? { kind: 'players', playerIds: ids, withSubject: true } : { kind: 'players', playerIds: ids },
    rest,
  };
}

// ---------- amounts ----------

const PERCENT = rx(String.raw`^(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?`);
const FRACTION = rx(
  String.raw`^(?:(half)|(?:a\s+|one\s+)?(quarter)|(all|everything|the\s+whole|the\s+entire))${END}(?:\s+of)?`,
);
const EVERYTHING_OWN = rx(String.raw`^everything\s+(?:they|he|she)\s+(?:has|have|owns?)${END}`);
const POT_BASE = rx(String.raw`^(?:the\s+)?(?:whole\s+|entire\s+|total\s+)?pot${END}`);
const OWN_BASE = rx(String.raw`^(?:their|his|her|its)\s+(?:chips?|stack|money|bankroll)${END}`);
const POSS_CHIPS = rx(String.raw`^(?:'s|’s)\s+(?:chips?|stack|money)${END}`);
const POSS_ONLY = rx(String.raw`^(?:'s|’s)${END}`);
const EACH = rx(String.raw`^each${END}`);

function parseBase(s: string, ctx: ParseContext): Hit<AmountBase> | null {
  const pot = take(s, POT_BASE);
  if (pot) return { value: { kind: 'pot' }, rest: pot.rest };
  const own = take(s, OWN_BASE);
  if (own) return { value: { kind: 'own' }, rest: own.rest };
  const party = parseParty(s, ctx, true);
  if (party) {
    const poss = take(party.rest, POSS_CHIPS);
    if (poss) return { value: { kind: 'chipsOf', party: party.value }, rest: poss.rest };
  }
  return null;
}

function parseAmount(s: string, ctx: ParseContext): Hit<Amount> | null {
  const everything = take(s, EVERYTHING_OWN);
  if (everything) {
    return { value: { kind: 'percent', pct: 100, of: { kind: 'own' } }, rest: everything.rest };
  }

  const percentLike = (pct: number, rest: string): Hit<Amount> => {
    if (!(pct > 0 && pct <= 1000)) throw new ParseError('Percentages must be between 0 and 1000.');
    const base = parseBase(rest, ctx);
    if (!base) {
      throw new ParseError('A percentage of what? Try "half of the pot", "25% of their chips" or "all of Bob\'s chips".');
    }
    const tail = take(base.rest, EACH)?.rest ?? base.rest;
    return { value: { kind: 'percent', pct, of: base.value }, rest: tail };
  };

  const pct = take(s, PERCENT);
  if (pct) return percentLike(Number(pct.match[1]!), pct.rest);

  const frac = take(s, FRACTION);
  if (frac) return percentLike(frac.match[1] ? 50 : frac.match[2] ? 25 : 100, frac.rest);

  const n = take(s, NUMBER_RE);
  if (!n) return null;
  let rest = n.rest;
  rest = take(rest, CHIPS_WORD)?.rest ?? rest;
  rest = take(rest, EACH)?.rest ?? rest;
  return { value: { kind: 'fixed', n: chipAmount(n.match[1]!) }, rest };
}

// ---------- hands and cards (conditions) ----------

const COUNT_RE = rx(
  String.raw`^(?:at\s+least\s+)?(an?|one|1|two|2|both|three|3|four|4|five|5|any|some)\s+`,
);
const COUNT_VALUE: Record<string, number> = {
  a: 1, an: 1, one: 1, '1': 1, any: 1, some: 1, two: 2, '2': 2, both: 2, three: 3, '3': 3,
  four: 4, '4': 4, five: 5, '5': 5,
};

const COLOR_RE = rx(String.raw`^(red|black)\s+`);
const FACE_RE = rx(String.raw`^(?:face|picture)\s+(cards?)${END}`);
const BROADWAY_RE = rx(String.raw`^broadway(?:\s+(cards?))?${END}`);
const RANK_NOUN_RE = rx(
  String.raw`^(${RANK_WORD_ALT})(e?s)?${END}(?:\s+of\s+(${SUIT_ALT})${END})?`,
);
const SUIT_NOUN_RE = rx(String.raw`^(${SUIT_ALT})${END}`);
const CARD_NOUN_RE = rx(String.raw`^(cards?)${END}`);
const OR_HIGHER = rx(String.raw`^or\s+(?:higher|better|above|more|up|greater)${END}`);
const OR_LOWER = rx(String.raw`^or\s+(?:lower|below|less|under|worse|smaller)${END}`);

interface Noun {
  match: CardMatch;
  plural: boolean;
  rest: string;
}

/** "ace", "hearts", "red card", "face cards", "ten or higher", "king of diamonds", ... */
function parseMatchNoun(s: string): Noun | null {
  let rest = s;
  const match: CardMatch = {};

  const color = take(rest, COLOR_RE);
  if (color) {
    match.color = color.match[1]!.toLowerCase() === 'red' ? 'red' : 'black';
    rest = color.rest;
  }

  const face = take(rest, FACE_RE);
  if (face) {
    match.minRank = 11;
    match.maxRank = 13;
    return { match, plural: face.match[1]!.toLowerCase() === 'cards', rest: face.rest };
  }
  const broadway = take(rest, BROADWAY_RE);
  if (broadway) {
    match.minRank = 10;
    return { match, plural: broadway.match[1]?.toLowerCase() === 'cards', rest: broadway.rest };
  }

  const rk = take(rest, RANK_NOUN_RE);
  if (rk) {
    const rank = rankOf(rk.match[1]!);
    const plural = rk.match[2] !== undefined;
    let r = rk.rest;
    if (rk.match[3] !== undefined) {
      match.rank = rank;
      match.suit = suitFromToken(rk.match[3]);
    } else {
      const hi = take(r, OR_HIGHER);
      const lo = hi ? null : take(r, OR_LOWER);
      if (hi) {
        match.minRank = rank;
        r = hi.rest;
      } else if (lo) {
        match.maxRank = rank;
        r = lo.rest;
      } else {
        match.rank = rank;
      }
      r = take(r, CARD_NOUN_RE)?.rest ?? r;
    }
    return { match, plural, rest: r };
  }

  if (match.color === undefined) {
    const suit = take(rest, SUIT_NOUN_RE);
    if (suit) {
      match.suit = suitFromToken(suit.match[1]!);
      return { match, plural: suit.match[1]!.toLowerCase().endsWith('s'), rest: suit.rest };
    }
  }
  const card = take(rest, CARD_NOUN_RE);
  if (card && match.color !== undefined) {
    return { match, plural: card.match[1]!.toLowerCase() === 'cards', rest: card.rest };
  }
  return null;
}

function parseDescriptor(s: string): Hit<{ match: CardMatch; count: number }> | null {
  let rest = s;
  let count: number | null = null;
  const c = take(rest, COUNT_RE);
  if (c) {
    count = COUNT_VALUE[c.match[1]!.toLowerCase()]!;
    rest = c.rest;
  }
  const noun = parseMatchNoun(rest);
  if (!noun) return null;
  return { value: { match: noun.match, count: count ?? (noun.plural ? 2 : 1) }, rest: noun.rest };
}

function parseHoleCards(s: string): Hit<Condition> | null {
  const d = parseDescriptor(s);
  if (!d) return null;
  if (d.value.count > 2) {
    throw new ParseError(
      `You only hold two cards, so you can't have ${d.value.count} matching cards. For the board, say "the board has ...".`,
    );
  }
  return { value: { kind: 'cards', match: d.value.match, count: d.value.count }, rest: d.rest };
}

const COMPACT_CARD = rx(String.raw`^(10|[2-9tjqka])([shdc♠♥♦♣])${END}`);
const OF_SUIT = rx(String.raw`^(?:the\s+|an?\s+)?(${RANK_WORD_ALT})\s+of\s+(${SUIT_ALT})${END}`);
const CARD_SEP = rx(String.raw`^(?:,\s*(?:and\s+)?|and\s+|&\s*)`);

/** Specific cards: "the ace of spades", "As", "7h", "As Kh". */
function parseSpecific(s: string): Hit<Condition> | null {
  const one = (t: string) => take(t, OF_SUIT) ?? take(t, COMPACT_CARD);
  const toCond = (h: { match: RegExpExecArray }): Condition => ({
    kind: 'cards',
    match: { rank: rankOf(h.match[1]!), suit: suitFromToken(h.match[2]!) },
    count: 1,
  });

  const first = one(s);
  if (!first) return null;
  const conds: Condition[] = [toCond(first)];
  let rest = first.rest;
  for (;;) {
    const sep = take(rest, CARD_SEP);
    const next = one(sep ? sep.rest : rest);
    if (!next) break;
    conds.push(toCond(next));
    rest = next.rest;
  }
  return { value: conds.length === 1 ? conds[0]! : { kind: 'and', parts: conds }, rest };
}

const NICKNAMES: { re: RegExp; high: Rank; low: Rank; suited: SuitMode }[] = [
  { re: rx(String.raw`^(?:pocket\s+)?(?:rockets|bullets)${END}`), high: 14, low: 14, suited: 'any' },
  { re: rx(String.raw`^(?:pocket\s+)?cowboys${END}`), high: 13, low: 13, suited: 'any' },
  { re: rx(String.raw`^(?:pocket\s+)?ladies${END}`), high: 12, low: 12, suited: 'any' },
  { re: rx(String.raw`^big\s+slick${END}`), high: 14, low: 13, suited: 'any' },
];
const POCKET_RANK = rx(String.raw`^${ART}pocket\s+(?:pair\s+(?:of\s+)?)?(${RANK_ALT})(?:e?s)?${END}`);
const POCKET_ANY = rx(String.raw`^${ART}pocket\s+pairs?${END}`);

function parsePocket(s: string): Hit<Condition> | null {
  for (const n of NICKNAMES) {
    const hit = take(s, n.re);
    if (hit) return { value: { kind: 'hole', high: n.high, low: n.low, suited: n.suited }, rest: hit.rest };
  }
  const pr = take(s, POCKET_RANK);
  if (pr) {
    const r = rankOf(pr.match[1]!);
    return { value: { kind: 'hole', high: r, low: r, suited: 'any' }, rest: pr.rest };
  }
  const any = take(s, POCKET_ANY);
  return any ? { value: { kind: 'pocketPair' }, rest: any.rest } : null;
}

const PAIR_OF = rx(String.raw`^${THE}pair\s+of\s+(${RANK_WORD_ALT})(?:e?s)?${END}`);
const RANK_HIGH = rx(String.raw`^${ART}(${RANK_WORD_ALT})[ -]high(?:\s+card)?${END}`);
const OR_BETTER = rx(String.raw`^or\s+(?:better|higher|above|stronger|more)${END}`);

const CATEGORY_RULES: { re: RegExp; category: HandCategory; royal: boolean }[] = [
  { re: rx(String.raw`^${THE}royal\s+flush${END}`), category: 8, royal: true },
  { re: rx(String.raw`^${THE}straight\s+flush${END}`), category: 8, royal: false },
  { re: rx(String.raw`^${THE}(?:four\s+of\s+a\s+kind|4\s+of\s+a\s+kind|quads)${END}`), category: 7, royal: false },
  { re: rx(String.raw`^${THE}(?:full\s+house|boat)${END}`), category: 6, royal: false },
  { re: rx(String.raw`^${THE}flush${END}`), category: 5, royal: false },
  { re: rx(String.raw`^${THE}straight${END}`), category: 4, royal: false },
  { re: rx(String.raw`^${THE}(?:three\s+of\s+a\s+kind|3\s+of\s+a\s+kind|trips)${END}`), category: 3, royal: false },
  { re: rx(String.raw`^${THE}(?:two|2)\s+pairs?${END}`), category: 2, royal: false },
  { re: rx(String.raw`^${THE}(?:one\s+)?pair${END}`), category: 1, royal: false },
  { re: rx(String.raw`^${THE}(?:high\s+card|nothing)${END}`), category: 0, royal: false },
];

function parseCategory(s: string): Hit<Condition> | null {
  const pairOf = take(s, PAIR_OF);
  if (pairOf) {
    return {
      value: { kind: 'category', category: 1, royal: false, orBetter: false, rank: rankOf(pairOf.match[1]!) },
      rest: pairOf.rest,
    };
  }
  const high = take(s, RANK_HIGH);
  if (high) {
    return {
      value: { kind: 'category', category: 0, royal: false, orBetter: false, rank: rankOf(high.match[1]!) },
      rest: high.rest,
    };
  }
  for (const c of CATEGORY_RULES) {
    const hit = take(s, c.re);
    if (!hit) continue;
    let rest = hit.rest;
    let orBetter = false;
    if (!c.royal) {
      const ob = take(rest, OR_BETTER);
      if (ob) {
        orBetter = true;
        rest = ob.rest;
      }
    }
    return { value: { kind: 'category', category: c.category, royal: c.royal, orBetter, rank: null }, rest };
  }
  return null;
}

const COMPACT = rx(String.raw`^([2-9tjqka])([2-9tjqka])([so])?${END}`);
const LETTER_FORM = rx(String.raw`^(10|[2-9tjqka])${END}\s*(?:[-/,&+]\s*)?(10|[2-9tjqka])${END}`);
const WORD_FORM = rx(
  String.raw`^${ART}(${RANK_WORD_ALT})${END}\s*(?:(?:[-/,&+]|and${END})\s*)?${ART}(${RANK_WORD_ALT})${END}`,
);
const MODIFIER = rx(String.raw`^(off[ -]?suited|off[ -]?suit|unsuited|suited)${END}`);

/** Two ranks: "72o", "AKs", "7 2 offsuit", "ace king suited". */
function parseHole(s: string): Hit<Condition> | null {
  const compact = take(s, COMPACT);
  const two = compact ?? take(s, LETTER_FORM) ?? take(s, WORD_FORM);
  if (!two) return null;

  const a = rankOf(two.match[1]!);
  const b = rankOf(two.match[2]!);
  let suited: SuitMode = 'any';
  let rest = two.rest;

  const flag = compact ? compact.match[3]?.toLowerCase() : undefined;
  if (flag === 's') {
    suited = 'suited';
  } else if (flag === 'o') {
    suited = 'offsuit';
  } else {
    const mod = take(rest, MODIFIER);
    if (mod) {
      suited = mod.match[1]!.toLowerCase() === 'suited' ? 'suited' : 'offsuit';
      rest = mod.rest;
    }
  }

  const high = Math.max(a, b) as Rank;
  const low = Math.min(a, b) as Rank;
  if (high === low) {
    if (suited === 'suited') throw new ParseError("A pair can't be suited.");
    suited = 'any';
  }
  return { value: { kind: 'hole', high, low, suited }, rest };
}

const SHAPE_CONNECTORS = rx(
  String.raw`^${ART}(?:(suited|off[ -]?suited|off[ -]?suit|unsuited)\s+)?connectors?${END}`,
);
const SHAPE_SUIT = rx(
  String.raw`^${ART}(suited|off[ -]?suited|off[ -]?suit|unsuited)(?:\s+(?:cards?|hand|starting\s+hand))?${END}`,
);

function parseShape(s: string): Hit<Condition> | null {
  const conn = take(s, SHAPE_CONNECTORS);
  if (conn) {
    const word = conn.match[1]?.toLowerCase();
    return {
      value: { kind: 'shape', suited: word === undefined ? null : word === 'suited', connected: true },
      rest: conn.rest,
    };
  }
  const suit = take(s, SHAPE_SUIT);
  if (suit) {
    return {
      value: { kind: 'shape', suited: suit.match[1]!.toLowerCase() === 'suited', connected: false },
      rest: suit.rest,
    };
  }
  return null;
}

function parseHand(s: string): Hit<Condition> | null {
  return (
    parsePocket(s) ??
    parseCategory(s) ??
    parseSpecific(s) ??
    parseHole(s) ??
    parseShape(s) ??
    parseHoleCards(s)
  );
}

// ---------- other conditions ----------

const SHOWDOWN = rx(
  String.raw`^(?:(?:at|in|on)\s+(?:a\s+|the\s+)?|(?:a|the)\s+|there\s+(?:is|was)\s+(?:a\s+)?|there's\s+(?:a\s+)?|it\s+(?:goes|went|reaches|reached|gets|got)\s+(?:to\s+)?(?:a\s+|the\s+)?)?show\s*down${END}`,
);
const ALL_FOLD = rx(
  String.raw`^(?:every(?:one|body)(?:\s+else)?|all\s+(?:the\s+)?others?|the\s+others)\s+(?:folds?|folded)${END}`,
);
const SYMBOL_OP = /^(>=|<=|==|=|>|<)\s*/;
const OPS: [RegExp, Compare][] = [
  [rx(String.raw`^(?:more\s+than|greater\s+than|bigger\s+than|larger\s+than|higher\s+than|over|above|exceeds?)${END}`), '>'],
  [rx(String.raw`^(?:at\s+least|no\s+less\s+than|minimum\s+of)${END}`), '>='],
  [rx(String.raw`^(?:less\s+than|fewer\s+than|smaller\s+than|lower\s+than|under|below)${END}`), '<'],
  [rx(String.raw`^(?:at\s+most|no\s+more\s+than|maximum\s+of|up\s+to)${END}`), '<='],
  [rx(String.raw`^(?:exactly|equal\s+to|equals?)${END}`), '='],
];
const OR_MORE = rx(String.raw`^or\s+(?:more|higher|greater|above|bigger|over)${END}`);
const OR_LESS = rx(String.raw`^or\s+(?:less|lower|fewer|below|under|smaller)${END}`);

function parseComparison(s: string): Hit<{ op: Compare; value: number }> | null {
  let rest = s;
  let op: Compare | null = null;
  const sym = take(rest, SYMBOL_OP);
  if (sym) {
    const t = sym.match[1]!;
    op = t === '>=' ? '>=' : t === '<=' ? '<=' : t === '>' ? '>' : t === '<' ? '<' : '=';
    rest = sym.rest;
  } else {
    for (const [re, o] of OPS) {
      const w = take(rest, re);
      if (w) {
        op = o;
        rest = w.rest;
        break;
      }
    }
  }
  const n = take(rest, NUMBER_RE);
  if (!n) return null;
  const value = statNumber(n.match[1]!);
  rest = take(n.rest, CHIPS_WORD)?.rest ?? n.rest;
  if (!op) {
    const more = take(rest, OR_MORE);
    const less = more ? null : take(rest, OR_LESS);
    if (more) {
      op = '>=';
      rest = more.rest;
    } else if (less) {
      op = '<=';
      rest = less.rest;
    } else {
      op = '=';
    }
  }
  return { value: { op, value }, rest };
}

const SUBJ = String.raw`(?:they|he|she|the\s+(?:winner|loser|player)|that\s+player)`;
const POT_STAT = rx(String.raw`^(?:the\s+)?(?:total\s+)?pot(?:\s+(?:is|was))?${END}`);
const CHIPS_STAT = rx(String.raw`^${SUBJ}\s+(?:has|have|had|holds?)\s+`);
const STACK_STAT = rx(String.raw`^(?:their|his|her)\s+(?:chips?|stack|chip\s+count)\s+(?:(?:is|are|was|were)\s+)?`);
const BET_STAT = rx(String.raw`^${SUBJ}\s+(?:bets?|put\s+in|puts\s+in|wagered|wagers|committed|commits)\s+`);
const PLAYERS_STAT = rx(String.raw`^there\s+(?:are|were|is|was)\s+`);
const PLAYERS_WORD = rx(String.raw`^(?:players?|people)${END}`);
const HEADS_UP = rx(String.raw`^(?:it(?:'s|\s+is)\s+)?heads[ -]?up${END}`);

function parseStat(s: string): Hit<Condition> | null {
  const headsUp = take(s, HEADS_UP);
  if (headsUp) return { value: { kind: 'stat', stat: 'players', op: '=', value: 2 }, rest: headsUp.rest };

  const simple = (re: RegExp, stat: 'pot' | 'chips' | 'bet'): Hit<Condition> | null => {
    const lead = take(s, re);
    if (!lead) return null;
    const c = parseComparison(lead.rest);
    if (!c) return null;
    return { value: { kind: 'stat', stat, op: c.value.op, value: c.value.value }, rest: c.rest };
  };
  const found =
    simple(POT_STAT, 'pot') ?? simple(CHIPS_STAT, 'chips') ?? simple(STACK_STAT, 'chips') ?? simple(BET_STAT, 'bet');
  if (found) return found;

  const there = take(s, PLAYERS_STAT);
  if (there) {
    const c = parseComparison(there.rest);
    const word = c ? take(c.rest, PLAYERS_WORD) : null;
    if (c && word) {
      return { value: { kind: 'stat', stat: 'players', op: c.value.op, value: c.value.value }, rest: word.rest };
    }
  }
  return null;
}

const BOARD = rx(String.raw`^the\s+board\s+(?:has|have|had|contains?|shows?|includes?)${END}`);

function parseBoard(s: string): Hit<Condition> | null {
  const lead = take(s, BOARD);
  if (!lead) return null;
  const d = parseDescriptor(lead.rest);
  if (!d) return null;
  if (d.value.count > 5) throw new ParseError("The board only has five cards.");
  return { value: { kind: 'board', match: d.value.match, count: d.value.count }, rest: d.rest };
}

function parseShowdown(s: string): Hit<Condition> | null {
  const yes = take(s, SHOWDOWN);
  if (yes) return { value: { kind: 'showdown', value: true }, rest: yes.rest };
  const no = take(s, ALL_FOLD);
  return no ? { value: { kind: 'showdown', value: false }, rest: no.rest } : null;
}

// ---------- combining conditions ----------

const NEG = rx(String.raw`^(?:not|without|no)${END}`);
const AND_TOKEN = rx(String.raw`^(?:and|but|plus)${END}`);
const OR_TOKEN = rx(String.raw`^or${END}`);

function makeNot(c: Condition): Condition {
  if (c.kind === 'not') return c.inner;
  if (c.kind === 'showdown') return { kind: 'showdown', value: !c.value };
  return { kind: 'not', inner: c };
}

function parseAtom(s: string): Hit<Condition> | null {
  const paren = take(s, /^\(\s*/);
  if (paren) {
    const inner = parseCond(paren.rest);
    if (!inner) return null;
    const close = take(inner.rest, /^\)/);
    if (!close) throw new ParseError('A "(" in the rule needs a matching ")".');
    return { value: inner.value, rest: close.rest };
  }
  return parseShowdown(s) ?? parseStat(s) ?? parseBoard(s) ?? parseHand(s);
}

function parseUnary(s: string): Hit<Condition> | null {
  const direct = parseAtom(s);
  if (direct) return direct;
  const neg = take(s, NEG);
  if (!neg) return null;
  const inner = parseUnary(neg.rest);
  return inner ? { value: makeNot(inner.value), rest: inner.rest } : null;
}

function parseAndExpr(s: string): Hit<Condition> | null {
  const first = parseUnary(s);
  if (!first) return null;
  const parts = [first.value];
  let rest = first.rest;
  for (;;) {
    const tok = take(rest, AND_TOKEN);
    if (!tok) break;
    const next = parseUnary(tok.rest);
    if (!next) break; // the "and" belongs to the payout instead
    parts.push(next.value);
    rest = next.rest;
  }
  return { value: parts.length === 1 ? parts[0]! : { kind: 'and', parts }, rest };
}

function parseCond(s: string): Hit<Condition> | null {
  const first = parseAndExpr(s);
  if (!first) return null;
  const parts = [first.value];
  let rest = first.rest;
  for (;;) {
    const tok = take(rest, OR_TOKEN);
    if (!tok) break;
    const next = parseAndExpr(tok.rest);
    if (!next) break;
    parts.push(next.value);
    rest = next.rest;
  }
  return { value: parts.length === 1 ? parts[0]! : { kind: 'or', parts }, rest };
}

const COND_EXAMPLES =
  'Examples: 7 2 offsuit, suited connectors, the ace of spades, two hearts, a flush or better, the pot is over 100.';

// ---------- payouts ----------

const GIVE_IMP = rx(String.raw`^(?:give|award|grant|add)${END}`);
const TAKE_IMP = rx(String.raw`^(?:take|remove|subtract|deduct|confiscate)${END}`);
const FINE_IMP = rx(String.raw`^(?:fine|charge|penalize|penalise)${END}`);
const SET_IMP = rx(String.raw`^(?:set|reset)${END}`);
const PAY_VERB = rx(String.raw`^(?:pays|pay|gives|give|sends|send|hands|hand|owes|owe|transfers|transfer|donates|donate)${END}`);
const GET_VERB = rx(String.raw`^(?:gets|get|receives|receive|collects|collect|takes|take|gains|gain|earns|earn|wins|win|pockets|pocket)${END}`);
const LOSE_VERB = rx(String.raw`^(?:loses|lose|forfeits|forfeit|drops|drop)${END}`);
const TO = rx(String.raw`^to${END}`);
const FROM = rx(String.raw`^from${END}`);
const IS_SET = rx(String.raw`^(?:chips?\s+)?(?:is|are)\s+(?:now\s+)?(?:set|reset)\s+to${END}`);
const HAS_N = rx(String.raw`^(?:chips?\s+)?(?:now\s+)?(?:has|have)\s+(?:exactly\s+)?(?=\d)`);
const EFFECT_SEP = rx(String.raw`^(?:;|,\s*(?:and\s+|then\s+)?|and\s+|then\s+|also\s+|plus\s+)`);

const EFFECT_HELP =
  'What should happen when that occurs? Example: everyone pays them 10 chips. Or: they get 50 chips.';

function parseSetNumber(s: string): Hit<number> {
  const n = take(s, NUMBER_RE);
  if (!n) throw new ParseError('Set to how many chips? Try "Bob\'s chips are set to 100".');
  return { value: chipAmount(n.match[1]!, 0), rest: take(n.rest, CHIPS_WORD)?.rest ?? n.rest };
}

function parseOneEffect(s: string, ctx: ParseContext): Hit<Effect> {
  const text = s.trim();
  if (!text) throw new ParseError(EFFECT_HELP);

  // --- commands like "give them 50 chips", "take 10 chips from everyone" ---
  const give = take(text, GIVE_IMP);
  if (give) {
    const party = parseParty(give.rest, ctx, true);
    if (party) {
      const amount = parseAmount(party.rest, ctx);
      if (!amount) throw new ParseError('How many chips? Try "give them 50 chips".');
      return { value: { kind: 'gain', to: party.value, amount: amount.value }, rest: amount.rest };
    }
    const amount = parseAmount(give.rest, ctx);
    if (!amount) throw new ParseError('How many chips? Try "give them 50 chips".');
    const to = take(amount.rest, TO);
    if (to) {
      const target = parseParty(to.rest, ctx, true);
      if (!target) throw new ParseError('Who gets the chips? Try "give 50 chips to Bob".');
      return { value: { kind: 'gain', to: target.value, amount: amount.value }, rest: target.rest };
    }
    return { value: { kind: 'gain', to: { kind: 'subject' }, amount: amount.value }, rest: amount.rest };
  }

  const tk = take(text, TAKE_IMP);
  if (tk) {
    const amount = parseAmount(tk.rest, ctx);
    if (!amount) throw new ParseError('How many chips? Try "take 10 chips from everyone".');
    const from = take(amount.rest, FROM);
    if (from) {
      const party = parseParty(from.rest, ctx, true);
      if (!party) throw new ParseError('Who loses the chips? Try "take 10 chips from everyone".');
      return { value: { kind: 'lose', from: party.value, amount: amount.value }, rest: party.rest };
    }
    return { value: { kind: 'lose', from: { kind: 'subject' }, amount: amount.value }, rest: amount.rest };
  }

  const fine = take(text, FINE_IMP);
  if (fine) {
    const party = parseParty(fine.rest, ctx, true);
    if (!party) throw new ParseError('Who? Try "fine them 10 chips".');
    const amount = parseAmount(party.rest, ctx);
    if (!amount) throw new ParseError('How many chips? Try "fine them 10 chips".');
    return { value: { kind: 'lose', from: party.value, amount: amount.value }, rest: amount.rest };
  }

  const set = take(text, SET_IMP);
  if (set) {
    const party = parseParty(set.rest, ctx, true);
    if (!party) throw new ParseError('Whose chips? Try "set Bob\'s chips to 100".');
    let rest = (take(party.rest, POSS_CHIPS) ?? take(party.rest, POSS_ONLY))?.rest ?? party.rest;
    rest = take(rest, CHIPS_WORD)?.rest ?? rest;
    const to = take(rest, TO);
    if (!to) throw new ParseError('Set to how many chips? Try "set Bob\'s chips to 100".');
    const n = parseSetNumber(to.rest);
    return { value: { kind: 'set', target: party.value, chips: n.value }, rest: n.rest };
  }

  // --- sentences like "everyone pays them 10 chips", "they get 50 chips" ---
  const first = parseParty(text, ctx, false);
  if (!first) {
    throw new ParseError(
      `I couldn't understand the payout: "${text}". Try "everyone pays them 10 chips", "they get 50 chips" or "player 2 gives player 3 10 chips".`,
    );
  }
  const after = first.rest;

  const poss = take(after, POSS_CHIPS) ?? take(after, POSS_ONLY);
  const afterPoss = poss ? poss.rest : after;
  const isSet = take(afterPoss, IS_SET);
  if (isSet) {
    const n = parseSetNumber(isSet.rest);
    return { value: { kind: 'set', target: first.value, chips: n.value }, rest: n.rest };
  }
  const hasN = take(afterPoss, HAS_N);
  if (hasN) {
    const n = parseSetNumber(hasN.rest);
    return { value: { kind: 'set', target: first.value, chips: n.value }, rest: n.rest };
  }

  const pay = take(after, PAY_VERB);
  if (pay) {
    const target = parseParty(pay.rest, ctx, true);
    if (target) {
      const amount = parseAmount(target.rest, ctx);
      if (!amount) throw new ParseError('How many chips? Put a number, like "pays them 10 chips".');
      return { value: { kind: 'transfer', from: first.value, to: target.value, amount: amount.value }, rest: amount.rest };
    }
    const amount = parseAmount(pay.rest, ctx);
    if (!amount) throw new ParseError('How many chips? Try "pays 10 chips".');
    const to = take(amount.rest, TO);
    if (to) {
      const party = parseParty(to.rest, ctx, true);
      if (!party) throw new ParseError('Who gets the chips? Try "gives 10 chips to player 3".');
      return { value: { kind: 'transfer', from: first.value, to: party.value, amount: amount.value }, rest: party.rest };
    }
    // "they pay 10 chips" with nobody receiving them: the chips go to the bank.
    return { value: { kind: 'lose', from: first.value, amount: amount.value }, rest: amount.rest };
  }

  const get = take(after, GET_VERB);
  if (get) {
    const amount = parseAmount(get.rest, ctx);
    if (!amount) throw new ParseError('How many chips? Try "gets 20 chips" or "gets 20 chips from everyone".');
    const from = take(amount.rest, FROM);
    if (from) {
      const pot = take(from.rest, POT_BASE);
      if (pot) return { value: { kind: 'gain', to: first.value, amount: amount.value }, rest: pot.rest };
      const party = parseParty(from.rest, ctx, true);
      if (!party) throw new ParseError('Who pays? Try "gets 20 chips from everyone".');
      return { value: { kind: 'transfer', from: party.value, to: first.value, amount: amount.value }, rest: party.rest };
    }
    return { value: { kind: 'gain', to: first.value, amount: amount.value }, rest: amount.rest };
  }

  const lose = take(after, LOSE_VERB);
  if (lose) {
    const amount = parseAmount(lose.rest, ctx);
    if (!amount) throw new ParseError('How many chips? Try "they lose 20 chips".');
    const to = take(amount.rest, TO);
    if (to) {
      const party = parseParty(to.rest, ctx, true);
      if (!party) throw new ParseError('Who gets them? Try "loses 20 chips to Bob".');
      return { value: { kind: 'transfer', from: first.value, to: party.value, amount: amount.value }, rest: party.rest };
    }
    return { value: { kind: 'lose', from: first.value, amount: amount.value }, rest: amount.rest };
  }

  throw new ParseError(
    'I expected "pays", "gives", "gets" or "loses" after that. Try "everyone pays them 10 chips".',
  );
}

function checkEffect(e: Effect): void {
  if (e.kind !== 'transfer') return;
  const group = (p: Party) => p.kind === 'everyone' || p.kind === 'others';
  if (group(e.from) && group(e.to)) {
    throw new ParseError(`"Everyone" can't be on both sides of a payment.`);
  }
  if (e.from.kind === 'subject' && e.to.kind === 'subject') {
    throw new ParseError("A player can't pay themselves.");
  }
  if (
    e.from.kind === 'players' && e.to.kind === 'players' &&
    !e.from.withSubject && !e.to.withSubject &&
    e.from.playerIds.length === 1 && e.to.playerIds.length === 1 &&
    e.from.playerIds[0] === e.to.playerIds[0]
  ) {
    throw new ParseError("A player can't pay themselves.");
  }
}

// ---------- rules ----------

const LEAD = rx(String.raw`^(?:if|when|whenever|every\s*time|each\s*time|any\s*time|anytime)${END}`);
const ANYONE = rx(
  String.raw`^(?:someone|somebody|anyone|anybody|whoever|any\s+player|a\s+player|one\s+of\s+the\s+players|a\s+person|each\s+player|every\s+player)${END}`,
);
const INTRO = rx(String.raw`^(?:with|holding|using|having|when|while|if|where|and|but|plus)${END}`);
const BARE_COND_START = rx(String.raw`^(?:without|not|no|at)${END}`);
const STRIP_THEN = /^(?:[,;:]\s*)?(?:then\b\s*)?/i;

const VERBS: { re: RegExp; trigger: Trigger; needsCond: boolean }[] = [
  {
    re: rx(String.raw`^(?:wins|win|won|takes\s+(?:down\s+)?the\s+pot)${END}(?:\s+(?:the|a)\s+(?:hand|pot|round|game)${END})?`),
    trigger: 'win', needsCond: false,
  },
  {
    re: rx(String.raw`^(?:loses|lose|lost)${END}(?:\s+(?:the|a)\s+(?:hand|pot|round|game)${END})?`),
    trigger: 'lose', needsCond: false,
  },
  { re: rx(String.raw`^(?:folds|fold|folded)${END}`), trigger: 'fold', needsCond: false },
  {
    re: rx(String.raw`^(?:(?:goes|go|went|is|are|was|gets|get)\s+all[ -]?in)${END}`),
    trigger: 'allin', needsCond: false,
  },
  { re: rx(String.raw`^(?:plays|play|played)${END}`), trigger: 'play', needsCond: false },
  {
    re: rx(String.raw`^(?:has|have|holds?|is\s+holding|are\s+holding|is\s+dealt|are\s+dealt|gets\s+dealt|get\s+dealt|was\s+dealt|were\s+dealt)${END}`),
    trigger: 'play', needsCond: true,
  },
];

function parseWho(s: string, ctx: ParseContext): Hit<TriggerWho> | null {
  const anyone = take(s, ANYONE);
  if (anyone) return { value: { kind: 'anyone' }, rest: anyone.rest };
  const first = parsePlayerOrMe(s, ctx);
  if (!first) return null;
  const ids = [first.value];
  let rest = first.rest;
  for (;;) {
    const sep = take(rest, WHO_SEP);
    if (!sep) break;
    const next = parsePlayerOrMe(sep.rest, ctx);
    if (!next) break;
    if (!ids.includes(next.value)) ids.push(next.value);
    rest = next.rest;
  }
  return { value: { kind: 'players', playerIds: ids }, rest };
}

function parseRule(text: string, ctx: ParseContext): Rule {
  const lead = take(text.trim(), LEAD);
  if (!lead) {
    throw new ParseError(
      'A rule starts with "if", "when" or "every time". Example: /rule if someone wins with 7 2 offsuit then everyone pays them 10 chips',
    );
  }
  const who = parseWho(lead.rest, ctx);
  if (!who) {
    throw new ParseError(
      `After "${lead.match[0]}" I expected who it applies to: "someone", a name, "player 3" or "me".`,
    );
  }

  let verb: { trigger: Trigger; needsCond: boolean; word: string; rest: string } | null = null;
  for (const v of VERBS) {
    const hit = take(who.rest, v.re);
    if (hit) {
      verb = { trigger: v.trigger, needsCond: v.needsCond, word: hit.match[0], rest: hit.rest };
      break;
    }
  }
  if (!verb) {
    throw new ParseError('I expected "wins", "loses", "folds", "goes all in" or "plays" after that.');
  }

  let rest = verb.rest;
  let cond: Condition | null = null;

  const intro = take(rest, INTRO);
  const softIntro = intro !== null && /^(?:and|but|plus)$/i.test(intro.match[0]);
  if (verb.needsCond) {
    const parsed = parseCond(intro ? intro.rest : rest);
    if (!parsed) {
      throw new ParseError(`I didn't understand what comes after "${verb.word}". ${COND_EXAMPLES}`);
    }
    cond = parsed.value;
    rest = parsed.rest;
  } else if (intro) {
    const parsed = parseCond(intro.rest);
    if (parsed) {
      cond = parsed.value;
      rest = parsed.rest;
    } else if (softIntro) {
      rest = intro.rest; // "...wins and everyone pays them 10": the "and" just joins the payout
    } else {
      throw new ParseError(`I didn't understand the condition after "${intro.match[0]}". ${COND_EXAMPLES}`);
    }
  } else if (BARE_COND_START.test(rest)) {
    const parsed = parseCond(rest);
    if (!parsed) throw new ParseError(`I didn't understand that condition. ${COND_EXAMPLES}`);
    cond = parsed.value;
    rest = parsed.rest;
  }

  rest = rest.replace(STRIP_THEN, '');

  const effects: Effect[] = [];
  for (;;) {
    const e = parseOneEffect(rest, ctx);
    checkEffect(e.value);
    effects.push(e.value);
    rest = e.rest;
    const sep = take(rest, EFFECT_SEP);
    if (!sep) break;
    rest = sep.rest;
    if (!rest.replace(/[\s.!]+$/u, '')) break;
  }
  const tail = rest.replace(/[\s.!]+$/u, '');
  if (tail) throw new ParseError(`I didn't understand "${tail}" at the end of the rule.`);
  if (effects.length > MAX_EFFECTS_PER_RULE) {
    throw new ParseError(`A rule can have at most ${MAX_EFFECTS_PER_RULE} payouts.`);
  }

  return { trigger: verb.trigger, who: who.value, cond, effects };
}

// ---------- chip commands ----------

function parseTargets(s: string, ctx: ParseContext): Hit<string[]> | null {
  const all = take(s, ALL_PLAYERS);
  if (all) return { value: ctx.players.map((p) => p.id), rest: all.rest };
  const first = parsePlayerOrMe(s, ctx);
  if (!first) return null;
  const ids = [first.value];
  let rest = first.rest;
  for (;;) {
    const sep = take(rest, LIST_SEP);
    if (!sep) break;
    const next = parsePlayerOrMe(sep.rest, ctx);
    if (!next) break;
    if (!ids.includes(next.value)) ids.push(next.value);
    rest = next.rest;
  }
  return { value: ids, rest };
}

const CHIPS_ARG = rx(
  String.raw`^(?:(?:to|by)\s+|=\s*|:\s*)?([+-])?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(?:chips?)?$`,
);
const PLAIN_AMOUNT = rx(String.raw`^(?:by\s+)?(\d{1,3}(?:,\d{3})+|\d+)\s*(?:chips?)?$`);
const AMOUNT_FIRST = rx(
  String.raw`^(\d{1,3}(?:,\d{3})+|\d+)\s*(?:chips?)?\s+(?:to|from)\s+([\s\S]+)$`,
);

function parseChips(args: string, ctx: ParseContext): Command {
  const targets = parseTargets(args, ctx);
  if (!targets) {
    throw new ParseError(
      `Who? Try /chips Bob 500, /chips Bob +50 or /chips everyone 500. ${listPlayers(ctx)}`,
    );
  }
  const m = CHIPS_ARG.exec(targets.rest);
  if (!m) throw new ParseError('How many chips? Try /chips Bob 500 (set) or /chips Bob +50 (add).');
  if (m[1]) {
    const n = chipAmount(m[2]!);
    return { kind: 'chips', playerIds: targets.value, mode: 'add', amount: m[1] === '-' ? -n : n };
  }
  return { kind: 'chips', playerIds: targets.value, mode: 'set', amount: chipAmount(m[2]!, 0) };
}

function parseGiveTake(args: string, ctx: ParseContext, sign: 1 | -1): Command {
  const usage =
    sign > 0 ? 'Try /give Bob 50 or /give everyone 100.' : 'Try /take Bob 20 or /take everyone 5.';
  const first = parseTargets(args, ctx);
  if (first) {
    const n = PLAIN_AMOUNT.exec(first.rest);
    if (!n) throw new ParseError(`How many chips? ${usage}`);
    return { kind: 'chips', playerIds: first.value, mode: 'add', amount: sign * chipAmount(n[1]!) };
  }
  const m = AMOUNT_FIRST.exec(args);
  if (m) {
    const targets = parseTargets(m[2]!.trim(), ctx);
    if (!targets || targets.rest) throw new ParseError(`Who? ${usage} ${listPlayers(ctx)}`);
    return { kind: 'chips', playerIds: targets.value, mode: 'add', amount: sign * chipAmount(m[1]!) };
  }
  throw new ParseError(`Who? ${usage} ${listPlayers(ctx)}`);
}

// ---------- commands ----------

function wholeNumber(text: string, min: number): number {
  return chipAmount(text, min);
}

function parse(input: string, ctx: ParseContext): Command {
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(input.trim());
  if (!m) throw new ParseError('Commands start with "/". Type /help to see them.');
  const name = m[1]!.toLowerCase();
  const args = m[2]!.trim();

  switch (name) {
    case 'help':
    case 'commands':
    case '?':
      return { kind: 'help' };

    case 'rules':
    case 'listrules':
      return { kind: 'listRules' };

    case 'settings':
      return { kind: 'showSettings' };

    case 'rule':
    case 'addrule':
    case 'newrule':
      if (!args) {
        throw new ParseError(
          'Say what the rule is. Example: /rule if someone wins with 7 2 offsuit then everyone pays them 10 chips',
        );
      }
      return { kind: 'addRule', rule: parseRule(args, ctx) };

    case 'remove':
    case 'delete':
    case 'removerule':
    case 'delrule': {
      const n = /^(?:rule\s*)?#?(\d+)$/i.exec(args);
      if (!n) throw new ParseError('Which rule? Try /remove rule 2 (type /rules to see the numbers).');
      return { kind: 'removeRule', number: Number(n[1]) };
    }

    case 'clear':
    case 'clearrules':
      if (name === 'clear' && !/^rules?$/i.test(args)) throw new ParseError('Did you mean /clear rules ?');
      return { kind: 'clearRules' };

    case 'kick': {
      const ref = parsePlayerRef(args, ctx);
      if (!ref || ref.rest) throw new ParseError(`Who? Try /kick Bob or /kick player 2. ${listPlayers(ctx)}`);
      return { kind: 'kick', playerId: ref.value };
    }

    case 'chips':
    case 'setchips':
      return parseChips(args, ctx);

    case 'give':
    case 'add':
      return parseGiveTake(args, ctx, 1);

    case 'take':
      return parseGiveTake(args, ctx, -1);

    case 'reset':
      if (args) throw new ParseError('/reset takes no extra words.');
      return { kind: 'reset' };

    case 'blinds': {
      const b = /^(\d+)\s*[/,\s]\s*(\d+)$/.exec(args);
      if (!b) throw new ParseError('Give both blinds, like /blinds 25/50.');
      return { kind: 'setBlinds', smallBlind: wholeNumber(b[1]!, 1), bigBlind: wholeNumber(b[2]!, 1) };
    }

    case 'minraise':
    case 'min-raise': {
      const r = /^(\d+)$/.exec(args);
      if (!r) throw new ParseError('Give a number, like /minraise 100.');
      return { kind: 'setMinRaise', amount: wholeNumber(r[1]!, 1) };
    }

    case 'rounds':
    case 'bettingrounds': {
      const r = /^([1-4])$/.exec(args);
      if (!r) throw new ParseError('Betting rounds must be 1, 2, 3 or 4, like /rounds 2.');
      return { kind: 'setRounds', rounds: Number(r[1]) };
    }

    case 'wrap':
    case 'wraparound': {
      const w = /^(on|off|yes|no|true|false)$/i.exec(args);
      if (!w) throw new ParseError('Say on or off, like /wrap on.');
      return { kind: 'setWrap', on: /^(on|yes|true)$/i.test(w[1]!) };
    }

    default:
      throw new ParseError(`I don't know the command /${name}. Type /help to see what I understand.`);
  }
}

export function parseCommand(input: string, ctx: ParseContext): ParseResult {
  try {
    return { ok: true, command: parse(input, ctx) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message };
    throw e;
  }
}