import { MAX_CHIPS, type Rank } from '@reverse-poker/shared';
import type { HandCategory } from '@reverse-poker/poker-engine';
import type { Effect, HandPattern, Party, Rule, SuitMode, TriggerWho } from './rules';

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
  | { kind: 'setChips'; playerId: string; chips: number }
  | { kind: 'reset' }
  | { kind: 'setBlinds'; smallBlind: number; bigBlind: number }
  | { kind: 'setMinRaise'; amount: number }
  | { kind: 'setRounds'; rounds: number }
  | { kind: 'setWrap'; on: boolean };

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string };

export const HELP_TEXT = [
  'Type a normal message to chat. Commands start with "/". Only the host can change things.',
  '',
  'Special rules (payouts when someone wins):',
  '  /rule if someone wins with 7 2 offsuit then everyone pays them 10 chips',
  '  /rule every time player 4 wins player 2 gives player 3 10 chips',
  '  /rule if Bob wins with a flush then the winner gets 20 chips from everyone',
  '  /rules (list)    /remove rule 2    /clear rules',
  '  Who wins: someone, a name, "player 3", me.',
  '  Hands: 7 2 offsuit, ace king suited, AKs, 72o, pocket aces, a pocket pair, a flush, a straight,',  '    a full house, four of a kind, three of a kind, two pair, a pair, a straight flush, a royal flush.',
  '  Hand names like "a flush" only count at a showdown.',
  '  Who pays: everyone, a name, "player 3", the winner (them).',
  '',
  'Players:  /kick Bob    /chips Bob 500    /reset',
  'Game:     /blinds 25/50    /minraise 100    /rounds 2    /wrap on|off    /settings',
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

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const RANK_WORDS: Record<string, Rank> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  jack: 11, queen: 12, king: 13, ace: 14, deuce: 2,
};

function rankOf(token: string): Rank {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t) as Rank;
  const letters: Record<string, Rank> = { t: 10, j: 11, q: 12, k: 13, a: 14 };
  return (letters[t] ?? RANK_WORDS[t]) as Rank;
}

// ---------- patterns ----------

const LEAD = rx(String.raw`^(?:if|when|whenever|every\s*time|each\s*time|any\s*time|anytime)${END}`);
const ANYONE = rx(
  String.raw`^(?:someone|somebody|anyone|anybody|whoever|any\s+player|a\s+player|one\s+of\s+the\s+players|a\s+person)${END}`,
);
const WIN_VERB = rx(String.raw`^(?:wins|win|won)${END}(?:\s+(?:the|a)\s+(?:hand|pot|round|game)${END})?`);
const WITH = rx(String.raw`^(?:with|holding|using)${END}`);
const PLAYER_NUMBER = rx(
  String.raw`^(?:player\s+#?|#)(\d+|one|two|three|four|five|six|seven|eight|nine|ten)${END}`,
);
const EVERYONE = rx(
  String.raw`^(?:every(?:one|body)(?:\s+else)?|all\s+(?:the\s+)?(?:other\s+)?players|all\s+(?:the\s+)?others|the\s+(?:others|rest))${END}`,
);
const WINNER_WORDS = rx(String.raw`^(?:the\s+winner|whoever\s+won|them|they|him|her|he|she)${END}`);
const ME = rx(String.raw`^(?:me|myself|i)${END}`);
const PAY_VERB = rx(String.raw`^(?:pays|pay|gives|give|sends|send|hands|owes|owe|transfers|transfer)${END}`);
const GET_VERB = rx(String.raw`^(?:gets|get|receives|receive|collects|collect|takes|take)${END}`);

const RANK_ALT = String.raw`10|[2-9]|ten|two|three|four|five|six|seven|eight|nine|jack|queen|king|ace|deuce|[tjqk]`;
const ART = String.raw`(?:an?\s+)?`;
const THE = String.raw`(?:(?:an?|the)\s+)?`;
const COMPACT = rx(String.raw`^([2-9tjqka])([2-9tjqka])([so])?${END}`);
const SPACED = rx(
  String.raw`^${ART}(${RANK_ALT})${END}\s*(?:[-/,&+]|and\b)?\s*${ART}(${RANK_ALT})${END}`,
);
const MODIFIER = rx(String.raw`^(off[ -]?suited|off[ -]?suit|unsuited|suited)${END}`);
const POCKET_RANK = rx(String.raw`^${ART}pocket\s+(?:pair\s+(?:of\s+)?)?(${RANK_ALT})(?:e?s)?${END}`);
const POCKET_ANY = rx(String.raw`^${ART}pocket\s+pair${END}`);

const CATEGORY_RULES: { re: RegExp; category: HandCategory; royal: boolean }[] = [
  { re: rx(String.raw`^${THE}royal\s+flush${END}`), category: 8, royal: true },
  { re: rx(String.raw`^${THE}straight\s+flush${END}`), category: 8, royal: false },
  { re: rx(String.raw`^${THE}(?:four\s+of\s+a\s+kind|4\s+of\s+a\s+kind|quads)${END}`), category: 7, royal: false },
  { re: rx(String.raw`^${THE}full\s+house${END}`), category: 6, royal: false },
  { re: rx(String.raw`^${THE}flush${END}`), category: 5, royal: false },
  { re: rx(String.raw`^${THE}straight${END}`), category: 4, royal: false },
  { re: rx(String.raw`^${THE}(?:three\s+of\s+a\s+kind|3\s+of\s+a\s+kind|trips|set)${END}`), category: 3, royal: false },
  { re: rx(String.raw`^${THE}(?:two|2)\s+pairs?${END}`), category: 2, royal: false },
  { re: rx(String.raw`^${THE}(?:one\s+)?pair${END}`), category: 1, royal: false },
  { re: rx(String.raw`^${THE}high\s+card${END}`), category: 0, royal: false },
];

// ---------- players, parties, amounts ----------

function listPlayers(ctx: ParseContext): string {
  return `Players: ${ctx.players.map((p, i) => `${i + 1} ${p.name}`).join(', ')}.`;
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

function hostId(ctx: ParseContext): string {
  if (!ctx.hostId) throw new ParseError('There is no host right now.');
  return ctx.hostId;
}

function parseParty(s: string, ctx: ParseContext): Hit<Party> | null {
  const ref = parsePlayerRef(s, ctx);
  if (ref) return { value: { kind: 'player', playerId: ref.value }, rest: ref.rest };
  const everyone = take(s, EVERYONE);
  if (everyone) return { value: { kind: 'everyone' }, rest: everyone.rest };
  const winner = take(s, WINNER_WORDS);
  if (winner) return { value: { kind: 'winner' }, rest: winner.rest };
  const me = take(s, ME);
  if (me) return { value: { kind: 'player', playerId: hostId(ctx) }, rest: me.rest };
  return null;
}

function parseAmount(s: string): Hit<number> | null {
  const m = take(s, /^(\d{1,3}(?:,\d{3})+|\d+)(?!\d)/);
  if (!m) return null;
  const n = Number(m.match[1]!.replace(/,/g, ''));
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CHIPS) {
    throw new ParseError(`Amounts must be whole numbers from 1 to ${MAX_CHIPS.toLocaleString('en-US')}.`);
  }
  let rest = m.rest;
  rest = take(rest, /^chips?\b/i)?.rest ?? rest;
  rest = take(rest, /^each\b/i)?.rest ?? rest;
  return { value: n, rest };
}

// ---------- hands ----------

function parseHand(s: string): Hit<HandPattern> | null {
  const pocket = take(s, POCKET_RANK);
  if (pocket) {
    const r = rankOf(pocket.match[1]!);
    return { value: { kind: 'hole', high: r, low: r, suited: 'any' }, rest: pocket.rest };
  }
  const anyPair = take(s, POCKET_ANY);
  if (anyPair) return { value: { kind: 'pocketPair' }, rest: anyPair.rest };

  const compact = take(s, COMPACT);
  const two = compact ?? take(s, SPACED);
  if (two) {
    const a = rankOf(two.match[1]!);
    const b = rankOf(two.match[2]!);
    let suited: SuitMode = 'any';
    let rest = two.rest;

    const flag = compact ? compact.match[3]?.toLowerCase() : undefined;
    if (flag === 's') suited = 'suited';
    else if (flag === 'o') suited = 'offsuit';
    else {
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

  for (const c of CATEGORY_RULES) {
    const hit = take(s, c.re);
    if (hit) return { value: { kind: 'category', category: c.category, royal: c.royal }, rest: hit.rest };
  }
  return null;
}

// ---------- rules ----------

function parseWinner(s: string, ctx: ParseContext): Hit<TriggerWho> | null {
  const anyone = take(s, ANYONE);
  if (anyone) return { value: { kind: 'anyone' }, rest: anyone.rest };
  const ref = parsePlayerRef(s, ctx);
  if (ref) return { value: { kind: 'player', playerId: ref.value }, rest: ref.rest };
  const me = take(s, ME);
  if (me) return { value: { kind: 'player', playerId: hostId(ctx) }, rest: me.rest };
  return null;
}

function parseEffect(s: string, ctx: ParseContext): Effect {
  const first = parseParty(s, ctx);
  if (!first) {
    throw new ParseError(
      `I couldn't understand the payout: "${s}". Try "everyone pays them 10 chips" or "player 2 gives player 3 10 chips".`,
    );
  }

  let effect: Effect;
  let rest: string;

  const pay = take(first.rest, PAY_VERB);
  const get = pay ? null : take(first.rest, GET_VERB);

  if (pay) {
    const party = parseParty(pay.rest, ctx);
    if (party) {
      const amount = parseAmount(party.rest);
      if (!amount) throw new ParseError('How many chips? Put a number, like "pays them 10 chips".');
      effect = { from: first.value, to: party.value, amount: amount.value };
      rest = amount.rest;
    } else {
      const amount = parseAmount(pay.rest);
      if (!amount) throw new ParseError('Who gets paid, and how many chips? Try "pays them 10 chips".');
      const to = take(amount.rest, /^to\b/i);
      const party2 = to ? parseParty(to.rest, ctx) : null;
      if (!party2) throw new ParseError('Who gets the chips? Try "gives 10 chips to player 3".');
      effect = { from: first.value, to: party2.value, amount: amount.value };
      rest = party2.rest;
    }
  } else if (get) {
    const amount = parseAmount(get.rest);
    if (!amount) throw new ParseError('How many chips? Try "gets 20 chips from everyone".');
    const from = take(amount.rest, /^from\b/i);
    const party = from ? parseParty(from.rest, ctx) : null;
    if (!party) throw new ParseError('Who pays? Try "gets 20 chips from everyone".');
    effect = { from: party.value, to: first.value, amount: amount.value };
    rest = party.rest;
  } else {
    throw new ParseError(
      `I expected "pays", "gives" or "gets" after that. Try "everyone pays them 10 chips".`,
    );
  }

  const tail = rest.replace(/^each\b\s*/i, '').replace(/[\s.!]+$/u, '');
  if (tail) throw new ParseError(`I didn't understand "${tail}" at the end of the rule.`);

  if (effect.from.kind === 'everyone' && effect.to.kind === 'everyone') {
    throw new ParseError(`"Everyone" can't be on both sides of a payment.`);
  }
  if (effect.from.kind === 'winner' && effect.to.kind === 'winner') {
    throw new ParseError("A player can't pay themselves.");
  }
  if (
    effect.from.kind === 'player' &&
    effect.to.kind === 'player' &&
    effect.from.playerId === effect.to.playerId
  ) {
    throw new ParseError("A player can't pay themselves.");
  }
  return effect;
}

function parseRule(text: string, ctx: ParseContext): Rule {
  const lead = take(text.trim(), LEAD);
  if (!lead) {
    throw new ParseError(
      'A rule starts with "if", "when" or "every time". Example: /rule if someone wins with 7 2 offsuit then everyone pays them 10 chips',
    );
  }
  const who = parseWinner(lead.rest, ctx);
  if (!who) {
    throw new ParseError(`After "${lead.match[0]}" I expected who wins: "someone", a name, or "player 3".`);
  }
  const win = take(who.rest, WIN_VERB);
  if (!win) throw new ParseError('I expected "wins" after that.');

  let rest = win.rest;
  let hand: HandPattern | null = null;
  const withKw = take(rest, WITH);
  if (withKw) {
    const parsed = parseHand(withKw.rest);
    if (!parsed) {
      throw new ParseError(
        `I didn't understand the hand after "with". Examples: 7 2 offsuit, ace king suited, AKs, pocket aces, a flush, a full house.`,      );
    }
    hand = parsed.value;
    rest = parsed.rest;
  }

  rest = rest.replace(/^(?:[,;:]\s*)?(?:then\b\s*)?/i, '');
  if (!rest) {
    throw new ParseError('What should happen when that occurs? Example: everyone pays them 10 chips.');
  }
  return { who: who.value, hand, effect: parseEffect(rest, ctx) };
}

// ---------- commands ----------

const rangeError = `Amounts must be whole numbers from 1 to ${MAX_CHIPS.toLocaleString('en-US')}.`;

function wholeNumber(text: string, min: number): number {
  const n = Number(text.replace(/,/g, ''));
  if (!Number.isSafeInteger(n) || n < min || n > MAX_CHIPS) throw new ParseError(rangeError);
  return n;
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
    case 'setchips': {
      const ref = parsePlayerRef(args, ctx);
      if (!ref) throw new ParseError(`Who? Try /chips Bob 500 or /chips player 2 500. ${listPlayers(ctx)}`);
      const amount = /^(?:to\s+|=\s*|:\s*)?(\d{1,3}(?:,\d{3})+|\d+)$/i.exec(ref.rest);
      if (!amount) throw new ParseError('How many chips? Try /chips Bob 500.');
      return { kind: 'setChips', playerId: ref.value, chips: wholeNumber(amount[1]!, 0) };
    }

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