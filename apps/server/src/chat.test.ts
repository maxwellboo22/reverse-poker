import { describe, it, expect } from 'vitest';
import { RANKS, SUITS, type Card, type Rank, type Suit } from '@reverse-poker/shared';
import { MAX_HOUSE_RULES } from './game/rules';
import { Room, STARTING_CHIPS, type RoomPlayer } from './game/room';

const RULE_72 = '/rule if someone wins with 7 2 offsuit then everyone pays them 10 chips';

function add(room: Room, name: string): RoomPlayer {
  const r = room.addPlayer(name);
  if (!r.ok) throw new Error(r.error);
  return r.player;
}

/** A room with the given players; the join announcements are already drained. */
function setup(names: string[] = ['Alice', 'Bob']) {
  const room = new Room('CHAT1');
  const players = names.map((n) => add(room, n));
  room.takePendingChat();
  return { room, players };
}

const sent = (room: Room) => room.takePendingChat().map((m) => m.text);

// ---- a stacked deck, so rule triggers can be tested with real hands ----

const RANK_CHARS: Record<string, Rank> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14,
};
const cards = (text: string): Card[] =>
  text.trim().split(/\s+/).map((t) => ({ rank: RANK_CHARS[t[0]!]!, suit: t[1] as Suit }));
const key = (c: Card) => `${c.rank}${c.suit}`;

function stackedDeck(buttonSeat: number, holeTexts: string[], boardText: string): Card[] {
  const n = holeTexts.length;
  const sb = n === 2 ? buttonSeat : (buttonSeat + 1) % n;
  const holes = holeTexts.map(cards);
  const board = cards(boardText);
  const used = new Set([...holes.flat(), ...board].map(key));
  const unused = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit }))).filter((c) => !used.has(key(c)));
  const burns = unused.splice(0, 3);
  const draws: Card[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) draws.push(holes[(sb + i) % n]![pass]!);
  }
  draws.push(burns[0]!, board[0]!, board[1]!, board[2]!, burns[1]!, board[3]!, burns[2]!, board[4]!);
  return [...unused, ...draws.reverse()]; // cards are drawn from the end
}

/** Everyone checks or calls until the hand ends. */
function playOut(room: Room): void {
  let guard = 0;
  while (room.handInProgress) {
    if (guard++ > 40) throw new Error('hand did not finish');
    const hand = room.hand!;
    const id = hand.seats[hand.toAct!]!.playerId;
    if (!room.act(id, { type: 'check' }).ok) {
      const called = room.act(id, { type: 'call' });
      if (!called.ok) throw new Error(`stuck: ${called.error}`);
    }
  }
}

describe('chatting', () => {
  it('plain messages go to everyone, with the sender name', () => {
    const { room, players } = setup();
    expect(room.handleChat(players[1]!.playerId, '  hello there  ')).toEqual({});
    expect(room.takePendingChat()).toMatchObject([{ kind: 'user', name: 'Bob', text: 'hello there' }]);
  });

  it('announces joins and leaves, and passes host on', () => {
    const room = new Room('CHAT2');
    const alice = add(room, 'Alice');
    const bob = add(room, 'Bob');
    expect(sent(room)).toEqual(['Alice joined the room.', 'Bob joined the room.']);
    room.removePlayer(alice.playerId);
    expect(sent(room)).toEqual(['Alice left the room.', 'Bob is now the host.']);
    expect(room.hostId).toBe(bob.playerId);
  });

  it('keeps a history, in order, for people who join late', () => {
    const { room, players } = setup();
    room.handleChat(players[0]!.playerId, 'first');
    const history = room.getChatHistory();
    expect(history.map((m) => m.text)).toContain('first');
    expect(history.map((m) => m.id)).toEqual([...history.map((m) => m.id)].sort((a, b) => a - b));
  });
});

describe('who can do what', () => {
  it('only the host can run changing commands; anyone can read', () => {
    const { room, players } = setup();
    const bob = players[1]!.playerId;
    expect(room.handleChat(bob, '/reset')).toEqual({ reply: { ok: false, text: 'Only the host can do that.' } });
    expect(room.handleChat(bob, RULE_72).reply).toEqual({ ok: false, text: 'Only the host can do that.' });
    expect(room.houseRules).toHaveLength(0);
    expect(room.handleChat(bob, '/help').reply?.ok).toBe(true);
    expect(room.handleChat(bob, '/rules').reply?.ok).toBe(true);
    expect(room.handleChat(bob, '/settings').reply?.text).toContain('blinds 5/10');
    expect(room.takePendingChat()).toEqual([]); // nothing was said publicly
  });

  it('a mistyped command is a private error, not a public message', () => {
    const { room, players } = setup();
    const out = room.handleChat(players[0]!.playerId, '/banana');
    expect(out.reply?.ok).toBe(false);
    expect(out.reply?.text).toContain('/help');
    expect(room.takePendingChat()).toEqual([]);
  });
});

describe('special rules', () => {
  it('adds, lists, shows in the lobby view, removes and clears', () => {
    const { room, players } = setup();
    const alice = players[0]!.playerId;

    expect(room.handleChat(alice, RULE_72)).toEqual({});
    expect(sent(room)).toEqual([
      'Rule 1 added: If someone wins with 7-2 offsuit: everyone else pays the winner 10 chips each.',
    ]);
    room.handleChat(alice, '/rule every time player 2 wins player 1 gives player 2 5 chips');
    room.takePendingChat();

    expect(room.lobbyViewFor(alice).houseRules).toEqual([
      { number: 1, text: 'If someone wins with 7-2 offsuit: everyone else pays the winner 10 chips each.', active: true },
      { number: 2, text: 'If Bob wins: Alice pays Bob 5 chips.', active: true },
    ]);
    expect(room.handleChat(alice, '/rules').reply?.text).toContain('Rule 2: If Bob wins');

    room.handleChat(alice, '/remove rule 1');
    expect(sent(room)[0]).toContain('Rule 1 removed');
    expect(room.houseRules).toHaveLength(1);
    expect(room.handleChat(alice, '/remove rule 9').reply?.text).toContain('no rule 9');

    room.handleChat(alice, '/clear rules');
    expect(room.houseRules).toHaveLength(0);
    expect(room.handleChat(alice, '/clear rules').reply?.ok).toBe(false);
  });

  it('limits how many rules there can be', () => {
    const { room, players } = setup();
    const alice = players[0]!.playerId;
    for (let i = 0; i < MAX_HOUSE_RULES; i++) expect(room.handleChat(alice, RULE_72)).toEqual({});
    expect(room.handleChat(alice, RULE_72).reply?.ok).toBe(false);
    expect(room.houseRules).toHaveLength(MAX_HOUSE_RULES);
  });

  it('marks a rule inactive after a named player leaves', () => {
    const { room, players } = setup(['Alice', 'Bob', 'Cara']);
    room.handleChat(players[0]!.playerId, '/rule if Cara wins then Bob pays Alice 5');
    expect(room.lobbyViewFor(players[0]!.playerId).houseRules[0]!.active).toBe(true);
    room.removePlayer(players[2]!.playerId);
    expect(room.lobbyViewFor(players[0]!.playerId).houseRules[0]!.active).toBe(false);
  });

  it('"me" means the host, and the rule keeps pointing at them', () => {
    const { room, players } = setup();
    room.handleChat(players[0]!.playerId, '/rule if I win then everyone pays me 10');
    expect(room.lobbyViewFor(players[1]!.playerId).houseRules[0]!.text).toBe(
      'If Alice wins: everyone else pays Alice 10 chips each.',
    );
  });
});

describe('rules firing in real hands', () => {
  /**
   * Heads-up, first hand: Alice is the button, the small blind and first to act.
   * The deck is rigged so the hole cards and board are exactly as given.
   */
  function headsUp(holeAlice: string, holeBob: string, board: string, rule = RULE_72) {
    const { room, players } = setup();
    const [alice, bob] = players as [RoomPlayer, RoomPlayer];
    expect(room.handleChat(alice.playerId, rule)).toEqual({});
    room.takePendingChat();
    expect(room.startNextHand(alice.playerId, stackedDeck(0, [holeAlice, holeBob], board))).toEqual({ ok: true });
    return { room, alice, bob };
  }

  it('pays the winner when their hole cards match', () => {
    // Alice: 7S 2D plus the board makes a full house, beating Bob's two pair.
    const { room, alice, bob } = headsUp('7S 2D', 'KS KH', '7C 7D 2H 9S 3C');
    playOut(room);

    expect(room.handInProgress).toBe(false);
    expect([alice.chips, bob.chips]).toEqual([1020, 980]); // 1010 / 990 from the pot, then 10 from the rule
    const lines = sent(room);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Rule 1 triggered: Alice won with 7-2 offsuit.');
    expect(lines[0]).toContain('Bob pays Alice 10');
    // The finished table shows the same numbers as the lobby.
    expect(room.tableViewFor(alice.playerId)!.seats.map((s) => s.stack)).toEqual([1020, 980]);
  });

  it('does nothing when the winner holds the cards suited instead', () => {
    const { room, alice, bob } = headsUp('7S 2S', 'KS KH', '7C 7D 2H 9S 3C');
    playOut(room);
    expect([alice.chips, bob.chips]).toEqual([1010, 990]);
    expect(sent(room)).toEqual([]);
  });

  it('hole-card rules also fire when everyone else folds', () => {
    // Alice folds, so Bob wins the blinds holding 7-2 offsuit.
    const { room, alice, bob } = headsUp('KS KH', '7S 2D', '9C 8D 3S 4H JD');
    expect(room.act(alice.playerId, { type: 'fold' })).toEqual({ ok: true });

    expect([alice.chips, bob.chips]).toEqual([985, 1015]); // 995 / 1005, then 10 from the rule
    const lines = sent(room);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Rule 1 triggered: Bob won with 7-2 offsuit.');
    expect(lines[0]).toContain('Alice pays Bob 10');
  });

  it('hand-name rules fire at a showdown but not when everyone folds', () => {
    const rule = '/rule if someone wins with a full house then everyone pays them 10 chips';

    const showdown = headsUp('7S 2D', 'KS KH', '7C 7D 2H 9S 3C', rule);
    playOut(showdown.room);
    expect([showdown.alice.chips, showdown.bob.chips]).toEqual([1020, 980]);
    expect(sent(showdown.room)[0]).toContain('won with a full house');

    const folded = headsUp('KS KH', '7S 2D', '9C 8D 3S 4H JD', rule);
    expect(folded.room.act(folded.alice.playerId, { type: 'fold' })).toEqual({ ok: true });
    expect([folded.alice.chips, folded.bob.chips]).toEqual([995, 1005]);
    expect(sent(folded.room)).toEqual([]);
  });

  it('runs the rules once per hand, never again', () => {
    const { room, alice, bob } = headsUp('7S 2D', 'KS KH', '7C 7D 2H 9S 3C');
    playOut(room);
    room.takePendingChat();

    room.removePlayer(bob.playerId); // touches the finished hand, but must not re-run the rules
    expect(sent(room)).toEqual(['Bob left the room.']);
    expect(alice.chips).toBe(1020);
  });
});

describe('host commands in chat', () => {
  it('/kick removes the player and says so', () => {
    const { room, players } = setup();
    const [alice, bob] = players as [RoomPlayer, RoomPlayer];
    expect(room.handleChat(alice.playerId, '/kick Bob')).toEqual({ kicked: { socketId: null } });
    expect(sent(room)).toEqual(['Bob was removed by the host.']);
    expect(room.players.has(bob.playerId)).toBe(false);
  });

  it("/kick can't remove the host, or someone who isn't there", () => {
    const { room, players } = setup();
    const alice = players[0]!.playerId;
    expect(room.handleChat(alice, '/kick Alice').reply?.text).toContain("can't remove yourself");
    expect(room.handleChat(alice, '/kick Zed').reply?.text).toContain('Who?');
    expect(room.players.size).toBe(2);
  });

  it('/chips sets chips between hands only', () => {
    const { room, players } = setup();
    const [alice, bob] = players as [RoomPlayer, RoomPlayer];
    expect(room.handleChat(alice.playerId, '/chips Bob 250')).toEqual({});
    expect(bob.chips).toBe(250);
    expect(sent(room)).toEqual(['Bob now has 250 chips (set by the host).']);

    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    room.takePendingChat();
    expect(room.handleChat(alice.playerId, '/chips Bob 5').reply).toEqual({
      ok: false, text: 'Chips can only be changed between hands.',
    });
    expect(bob.chips).toBe(250);
  });

  it('/reset ends the hand, restores chips and asks for tables to be cleared', () => {
    const { room, players } = setup();
    const [alice, bob] = players as [RoomPlayer, RoomPlayer];
    expect(room.startNextHand(alice.playerId)).toEqual({ ok: true });
    room.takePendingChat();

    expect(room.handleChat(alice.playerId, '/reset')).toEqual({ tablesCleared: true });
    expect(room.hand).toBeNull();
    expect([alice.chips, bob.chips]).toEqual([STARTING_CHIPS, STARTING_CHIPS]);
    expect(sent(room)[0]).toContain('reset the lobby');
  });

  it('/blinds, /minraise, /rounds and /wrap change the settings and announce them', () => {
    const { room, players } = setup();
    const alice = players[0]!.playerId;

    expect(room.handleChat(alice, '/blinds 25/50')).toEqual({});
    expect(sent(room)[0]).toContain('blinds 25/50');
    expect(room.settings).toMatchObject({ smallBlind: 25, bigBlind: 50 });

    room.handleChat(alice, '/minraise 100');
    room.handleChat(alice, '/rounds 2');
    room.handleChat(alice, '/wrap on');
    expect(room.settings).toEqual({
      smallBlind: 25, bigBlind: 50, minRaise: 100, bettingRounds: 2, wrapAroundStraights: true,
    });
    room.takePendingChat();

    expect(room.handleChat(alice, '/blinds 60/50').reply?.text).toContain("can't be bigger");
    expect(room.settings.smallBlind).toBe(25);
  });

  it('the new settings are used by the next hand', () => {
    const { room, players } = setup();
    const alice = players[0]!.playerId;
    room.handleChat(alice, '/blinds 25/50');
    room.handleChat(alice, '/rounds 1');
    expect(room.startNextHand(alice)).toEqual({ ok: true });
    expect(room.hand).toMatchObject({ smallBlind: 25, bigBlind: 50, bettingRounds: 1 });
  });
});