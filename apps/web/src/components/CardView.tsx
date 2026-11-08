import type { Card, Suit } from '@reverse-poker/shared';

const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABEL: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function CardView({ card }: { card: Card }) {
  const red = card.suit === 'H' || card.suit === 'D';
  return (
    <div className={`card${red ? ' red' : ''}`}>
      <span>{RANK_LABEL[card.rank] ?? card.rank}</span>
      <span>{SUIT_SYMBOL[card.suit]}</span>
    </div>
  );
}

export function CardBack() {
  return <div className="card back" aria-label="hidden card" />;
}