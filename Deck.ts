import { v4 as uuidv4 } from 'uuid';
import { Card, CardType } from './types.js';

export class Deck {
  cards: Card[] = [];

  constructor(playerCount?: number) {
    if (playerCount !== undefined) {
      this.buildStandardDeck(playerCount);
    }
  }

  /**
   * Builds the standard deck based on the 59 action/kitty cards rule.
   * Total = playerCount - 1 Kabooms, playerCount + 4 Defuses, and 59 Actions/Kitties.
   */
  private buildStandardDeck(playerCount: number) {
    this.buildActionPool();
    
    // Add Defuses (4 stay in deck, N players get 1 each outside this class)
    // To preserve compat if constructor is used directly:
    for (let i = 0; i < 4; i++) {
      this.cards.push({ id: uuidv4(), type: 'defuse' });
    }
    // Add Kabooms
    for (let i = 0; i < playerCount - 1; i++) {
      this.cards.push({ id: uuidv4(), type: 'kaboom' });
    }
    this.shuffle();
  }

  /**
   * Creates the base pool of 92 action and kitty cards.
   */
  public buildActionPool() {
    const pool: CardType[] = [];
    
    // Fixed Action Card Distribution (56 cards)
    const actionCounts: Record<string, number> = {
      'nope': 10,
      'attack': 8,
      'skip': 8,
      'demand': 8,
      'shuffle': 8,
      'peek': 10,
      'fate_switch': 4
    };

    for (const [type, count] of Object.entries(actionCounts)) {
      for (let i = 0; i < count; i++) {
        pool.push(type as CardType);
      }
    }

    // Fixed Kitty Card Distribution (40 cards)
    const kittyTypes: CardType[] = ['taco_cat', 'beard_cat', 'cattermelon', 'hairy_potato_cat', 'rainbow_ralphing_cat'];
    for (const type of kittyTypes) {
      for (let i = 0; i < 8; i++) { // 8 of each = 40
        pool.push(type);
      }
    }

    this.cards = pool.map(type => ({ id: uuidv4(), type }));
    this.shuffle();
  }

  public addCards(type: CardType, count: number) {
    for (let i = 0; i < count; i++) {
      this.cards.push({ id: uuidv4(), type });
    }
    this.shuffle();
  }

  public shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j]!, this.cards[i]!];
    }
  }

  public draw(): Card | undefined {
    return this.cards.pop();
  }

  public insertAt(card: Card, index: number) {
    const realIndex = this.cards.length - index;
    const boundedIndex = Math.max(0, Math.min(this.cards.length, realIndex));
    this.cards.splice(boundedIndex, 0, card);
  }

  public peek(count: number): Card[] {
    return this.cards.slice(-count).reverse();
  }

  public get count() {
    return this.cards.length;
  }
}
