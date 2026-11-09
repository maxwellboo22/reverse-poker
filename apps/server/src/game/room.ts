import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_SETTINGS, MAX_CHAT_HISTORY, MAX_CHIPS, MAX_PLAYERS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH,
  SettingsSchema, rulesSummary,
  type Ack, type Card, type ChatMessage, type ChatReply, type ClientAction, type LobbyView,
  type RoomSettings, type TableView,
} from '@reverse-poker/shared';
import {
  applyAction, forceFold, startHand, toTableView, type HandState,
} from '@reverse-poker/poker-engine';
import { HELP_TEXT, parseCommand } from './commands';
import { MAX_HOUSE_RULES, describeRule, evaluateRules, type Rule, type WinnerInfo } from './rules';

export const STARTING_CHIPS = 1000;

export interface RoomPlayer {
  playerId: string;
  name: string;
  token: string;          // SECRET: only ever sent to this player, once
  chips: number;
  socketId: string | null; // null = disconnected
}

/** What the transport layer must do after a chat message or command. */
export interface ChatOutcome {
  /** A private answer for the sender. */
  reply?: ChatReply;
  /** Set when someone was kicked, so their socket can be told. */
  kicked?: { socketId: string | null };
  /** Set when the lobby was reset, so every client drops its table. */
  tablesCleared?: boolean;
}

export class Room {
  readonly code: string;
  hostId: string | null = null;
  readonly players = new Map<string, RoomPlayer>(); // insertion order = seat order
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  houseRules: Rule[] = [];
  hand: HandState | null = null;

  private handsPlayed = 0;
  private processedHandId: string | null = null;
  private chat: ChatMessage[] = [];
  private pendingChat: ChatMessage[] = [];
  private nextChatId = 1;

  constructor(code: string) {
    this.code = code;
  }

  get handInProgress(): boolean {
    return this.hand !== null && this.hand.phase !== 'complete';
  }

  isConnected(playerId: string): boolean {
    return this.players.get(playerId)?.socketId != null;
  }

  hasConnectedPlayers(): boolean {
    return [...this.players.values()].some((p) => p.socketId !== null);
  }

  // ---------- chat ----------

  getChatHistory(): ChatMessage[] {
    return [...this.chat];
  }

  /** Messages not yet sent to clients. The server drains this after every change. */
  takePendingChat(): ChatMessage[] {
    const out = this.pendingChat;
    this.pendingChat = [];
    return out;
  }

  private push(message: Omit<ChatMessage, 'id'>): void {
    const m: ChatMessage = { id: this.nextChatId++, ...message };
    this.chat.push(m);
    if (this.chat.length > MAX_CHAT_HISTORY) this.chat.shift();
    this.pendingChat.push(m);
  }

  private say(text: string): void {
    this.push({ kind: 'system', name: '', text });
  }

  private fail(text: string): ChatOutcome {
    return { reply: { ok: false, text } };
  }

  /** A chat line or a "/" command. Commands other than the read-only ones are host-only. */
  handleChat(playerId: string, rawText: string): ChatOutcome {
    const player = this.players.get(playerId);
    if (!player) return this.fail('You are not in this room.');
    const text = rawText.trim();
    if (!text) return {};

    if (!text.startsWith('/')) {
      this.push({ kind: 'user', name: player.name, text });
      return {};
    }

    const parsed = parseCommand(text, {
      players: [...this.players.values()].map((p) => ({ id: p.playerId, name: p.name })),
      hostId: this.hostId,
    });
    if (!parsed.ok) return this.fail(parsed.error);
    const cmd = parsed.command;

    if (cmd.kind === 'help') return { reply: { ok: true, text: HELP_TEXT } };
    if (cmd.kind === 'listRules') return { reply: { ok: true, text: this.rulesListText() } };
    if (cmd.kind === 'showSettings') {
      return { reply: { ok: true, text: `Current rules: ${rulesSummary(this.settings)}` } };
    }
    if (playerId !== this.hostId) return this.fail('Only the host can do that.');

    switch (cmd.kind) {
      case 'addRule': {
        if (this.houseRules.length >= MAX_HOUSE_RULES) {
          return this.fail(`You can have at most ${MAX_HOUSE_RULES} special rules. Remove one with /remove rule <number>.`);
        }
        this.houseRules.push(cmd.rule);
        this.say(`Rule ${this.houseRules.length} added: ${this.ruleText(cmd.rule)}`);
        return {};
      }
      case 'removeRule': {
        const rule = this.houseRules[cmd.number - 1];
        if (!rule) return this.fail(`There is no rule ${cmd.number}. Type /rules to see them.`);
        const text = this.ruleText(rule);
        this.houseRules.splice(cmd.number - 1, 1);
        this.say(`Rule ${cmd.number} removed: ${text}`);
        return {};
      }
      case 'clearRules': {
        const count = this.houseRules.length;
        if (count === 0) return this.fail('There are no special rules to clear.');
        this.houseRules = [];
        this.say(`All ${count} special rule${count === 1 ? '' : 's'} removed.`);
        return {};
      }
      case 'kick': {
        const result = this.kick(playerId, cmd.playerId);
        if (!result.ok) {
          return this.fail(
            result.error === 'cannot_kick_self'
              ? "You can't remove yourself. Use the Leave room button."
              : 'That player is no longer in the room.',
          );
        }
        return { kicked: { socketId: result.socketId } };
      }
      case 'setChips': {
        const result = this.setChips(playerId, cmd.playerId, cmd.chips);
        if (!result.ok) {
          return this.fail(
            result.error === 'hand_in_progress'
              ? 'Chips can only be changed between hands.'
              : result.error === 'no_such_player'
                ? 'That player is no longer in the room.'
                : 'That amount is not valid.',
          );
        }
        return {};
      }
      case 'reset': {
        const result = this.resetLobby(playerId);
        return result.ok ? { tablesCleared: true } : this.fail('Only the host can do that.');
      }
      case 'setBlinds':
        return this.changeSettings(playerId, { smallBlind: cmd.smallBlind, bigBlind: cmd.bigBlind });
      case 'setMinRaise':
        return this.changeSettings(playerId, { minRaise: cmd.amount });
      case 'setRounds':
        return this.changeSettings(playerId, { bettingRounds: cmd.rounds });
      case 'setWrap':
        return this.changeSettings(playerId, { wrapAroundStraights: cmd.on });
      default:
        return {};
    }
  }

  private changeSettings(playerId: string, patch: Partial<RoomSettings>): ChatOutcome {
    const result = this.setSettings(playerId, { ...this.settings, ...patch });
    if (result.ok) return {};
    return this.fail(
      result.error === 'blinds_order'
        ? "The small blind can't be bigger than the big blind."
        : "Those numbers aren't valid.",
    );
  }

  private ruleText(rule: Rule): string {
    return describeRule(rule, (id) => this.players.get(id)?.name ?? null).text;
  }

  private rulesListText(): string {
    if (this.houseRules.length === 0) {
      return 'There are no special rules yet. The host can add one with /rule (type /help for examples).';
    }
    return this.houseRules
      .map((rule, i) => {
        const d = describeRule(rule, (id) => this.players.get(id)?.name ?? null);
        return `Rule ${i + 1}: ${d.text}${d.active ? '' : ' (inactive: a player in this rule left)'}`;
      })
      .join('\n');
  }

  // ---------- players ----------

  addPlayer(name: string): Ack<{ player: RoomPlayer }> {
    if (this.handInProgress) return { ok: false, error: 'game_in_progress' };
    if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'room_full' };
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return { ok: false, error: 'name_taken' };

    const player: RoomPlayer = {
      playerId: randomUUID(),
      name,
      token: randomBytes(32).toString('hex'),
      chips: STARTING_CHIPS,
      socketId: null,
    };
    this.players.set(player.playerId, player);
    this.hostId ??= player.playerId;
    this.say(`${name} joined the room.`);
    return { ok: true, player };
  }

  /**
   * Removes a player. Mid-hand they fold, and what they bet this round is
   * returned (see forceFold). If the host leaves, host passes to the first
   * connected player. Returns false if the player wasn't in the room.
   */
  removePlayer(playerId: string, announce = true): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    if (announce) this.say(`${player.name} left the room.`);

    if (this.handInProgress && this.hand!.seats.some((s) => s.playerId === playerId)) {
      const folded = forceFold(this.hand!, playerId);
      if (folded.ok) this.hand = folded.state;
    }
    this.players.delete(playerId);

    if (this.hostId === playerId) {
      const remaining = [...this.players.values()];
      const next = remaining.find((p) => p.socketId !== null) ?? remaining[0];
      this.hostId = next?.playerId ?? null;
      if (next) this.say(`${next.name} is now the host.`);
    }
    this.finishHandIfNeeded(); // the hand may have just ended
    return true;
  }

  /** Host only: removes another player. Returns their socket id so the server can tell them. */
  kick(requesterId: string, targetId: string): Ack<{ socketId: string | null }> {
    if (requesterId !== this.hostId) return { ok: false, error: 'not_host' };
    if (targetId === requesterId) return { ok: false, error: 'cannot_kick_self' };
    const target = this.players.get(targetId);
    if (!target) return { ok: false, error: 'no_such_player' };
    const socketId = target.socketId;
    this.say(`${target.name} was removed by the host.`);
    this.removePlayer(targetId, false);
    return { ok: true, socketId };
  }

  /** Host only. Applies from the next hand; a hand in progress keeps its rules. */
  setSettings(requesterId: string, input: unknown): Ack {
    if (requesterId !== this.hostId) return { ok: false, error: 'not_host' };
    const parsed = SettingsSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'bad_request' };
    if (parsed.data.smallBlind > parsed.data.bigBlind) return { ok: false, error: 'blinds_order' };
    this.settings = parsed.data;
    this.say(`Game rules updated (from the next hand): ${rulesSummary(this.settings)}`);
    return { ok: true };
  }

  /** Host only: abandons the current hand and gives everyone the starting chips. */
  resetLobby(requesterId: string): Ack {
    if (requesterId !== this.hostId) return { ok: false, error: 'not_host' };
    this.hand = null;
    this.processedHandId = null;
    this.handsPlayed = 0;
    for (const p of this.players.values()) p.chips = STARTING_CHIPS;
    this.say(`The host reset the lobby. Everyone is back to ${STARTING_CHIPS} chips.`);
    return { ok: true };
  }

  /** Host only, and only between hands (changing a stack mid-hand would corrupt the pots). */
  setChips(requesterId: string, targetId: string, chips: number): Ack {
    if (requesterId !== this.hostId) return { ok: false, error: 'not_host' };
    if (this.handInProgress) return { ok: false, error: 'hand_in_progress' };
    const target = this.players.get(targetId);
    if (!target) return { ok: false, error: 'no_such_player' };
    if (!Number.isInteger(chips) || chips < 0 || chips > MAX_CHIPS) {
      return { ok: false, error: 'bad_request' };
    }
    target.chips = chips;
    this.say(`${target.name} now has ${chips.toLocaleString('en-US')} chips (set by the host).`);
    return { ok: true };
  }

  /** Checks a reconnect token in constant time. */
  authenticate(playerId: string, token: string): RoomPlayer | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    const a = Buffer.from(player.token);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return player;
  }

  // ---------- the game ----------

  /** `testDeck` exists for tests only: the socket layer never passes it. */
  startNextHand(playerId: string, testDeck?: Card[]): Ack {
    if (playerId !== this.hostId) return { ok: false, error: 'not_host' };
    if (this.handInProgress) return { ok: false, error: 'hand_in_progress' };

    const seated = [...this.players.values()].filter((p) => p.chips > 0);
    if (seated.length < 2) return { ok: false, error: 'not_enough_players' };

    this.hand = startHand({
      players: seated.map((p) => ({ playerId: p.playerId, name: p.name, stack: p.chips })),
      buttonSeat: this.handsPlayed % seated.length, // simple rotation for the MVP
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
      minRaise: this.settings.minRaise,
      bettingRounds: this.settings.bettingRounds,
      wrapAroundStraights: this.settings.wrapAroundStraights,
      deck: testDeck,
    });
    this.handsPlayed += 1;
    this.finishHandIfNeeded(); // a hand can finish instantly if blinds put someone all-in
    return { ok: true };
  }

  act(playerId: string, action: ClientAction): Ack {
    if (!this.hand) return { ok: false, error: 'no_hand' };
    const result = applyAction(this.hand, playerId, action);
    if (!result.ok) return { ok: false, error: result.error };
    this.hand = result.state;
    this.finishHandIfNeeded();
    return { ok: true };
  }

  /** null if this player isn't part of the current hand. */
  tableViewFor(playerId: string): TableView | null {
    const hand = this.hand;
    if (!hand || !hand.seats.some((s) => s.playerId === playerId)) return null;
    return toTableView(hand, playerId, {
      roomCode: this.code,
      isConnected: (id) => this.isConnected(id),
    });
  }

  /** Allowlisted: tokens and socket ids never appear here. */
  lobbyViewFor(playerId: string): LobbyView {
    return {
      code: this.code,
      you: playerId,
      hostId: this.hostId ?? '',
      handInProgress: this.handInProgress,
      settings: { ...this.settings },
      houseRules: this.houseRules.map((rule, i) => {
        const d = describeRule(rule, (id) => this.players.get(id)?.name ?? null);
        return { number: i + 1, text: d.text, active: d.active };
      }),
      players: [...this.players.values()].map((p) => ({
        playerId: p.playerId,
        name: p.name,
        chips: p.chips,
        connected: p.socketId !== null,
      })),
    };
  }

  // ---------- internals ----------

  /** Once per hand, when it completes: sync chips back, then run the special rules. */
  private finishHandIfNeeded(): void {
    const hand = this.hand;
    if (!hand || hand.phase !== 'complete' || this.processedHandId === hand.handId) return;
    this.processedHandId = hand.handId;
    this.syncChips();
    this.runHouseRules(hand);
  }

  private syncChips(): void {
    if (!this.hand || this.hand.phase !== 'complete') return;
    for (const seat of this.hand.seats) {
      const p = this.players.get(seat.playerId);
      if (p) p.chips = seat.stack;
    }
  }

  private runHouseRules(hand: HandState): void {
    if (this.houseRules.length === 0 || !hand.result) return;

    const winners: WinnerInfo[] = hand.result.winners
      .filter((w) => w.amount > 0)
      .flatMap((w) => {
        const seat = hand.seats[w.seat]!;
        if (!seat.holeCards || !this.players.has(seat.playerId)) return [];
        return [{ playerId: seat.playerId, holeCards: seat.holeCards, rank: w.rank }];
      });

    const outcome = evaluateRules(
      this.houseRules,
      winners,
      [...this.players.values()].map((p) => ({ id: p.playerId, name: p.name, chips: p.chips })),
    );

    if (outcome.changed) {
      for (const p of this.players.values()) p.chips = outcome.chips.get(p.playerId) ?? p.chips;
      // Keep the finished table showing the same numbers as the lobby.
      for (const s of hand.seats) {
        const c = outcome.chips.get(s.playerId);
        if (c !== undefined) s.stack = c;
      }
      hand.version += 1;
    }
    for (const line of outcome.lines) this.say(line);
  }
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET.charAt(randomInt(ROOM_CODE_ALPHABET.length));
  }
  return code;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  create(): Room {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = randomCode();
      if (!this.rooms.has(code)) {
        const room = new Room(code);
        this.rooms.set(code, room);
        return room;
      }
    }
    throw new Error('could not allocate a room code');
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }
}