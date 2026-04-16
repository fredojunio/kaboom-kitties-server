import { v4 as uuidv4 } from 'uuid';
import { Card, CardType } from './types.js';

export class Deck {
  cards: Card[] = [];

  constructor(playerCount: number) {
    this.buildDeck(playerCount);
  }

  private buildDeck(playerCount: number) {
    const defaultDeck: CardType[] = [];
    
    // Scale action and kitty cards based on player count to keep the game duration balanced
    const actionPerType = Math.max(3, Math.floor(playerCount * 1.5));
    const kittyPerType = Math.max(2, Math.floor(playerCount * 1.0));

    // Action Cards
    const actionTypes: CardType[] = ['skip', 'attack', 'peek', 'shuffle', 'demand', 'nope'];
    for (const type of actionTypes) {
      for (let i = 0; i < actionPerType; i++) {
        defaultDeck.push(type);
      }
    }

    // Kitty Cards
    const kittyTypes: CardType[] = ['taco_cat', 'beard_cat', 'cattermelon', 'hairy_potato_cat', 'rainbow_ralphing_cat'];
    for (const type of kittyTypes) {
      for (let i = 0; i < kittyPerType; i++) {
        defaultDeck.push(type);
      }
    }

    // Convert string array to Card objects
    this.cards = defaultDeck.map(type => ({ id: uuidv4(), type }));

    // Shuffle the non-Kaboom/Defuse deck first
    this.shuffle();

    // The game requires extra Defuses in the deck depending on player count.
    // Total Defuse matches in deck = 4. Total defuse per player = 1.
    // Let's add the 4 Defuse cards to the deck.
    for (let i = 0; i < 4; i++) {
      this.cards.push({ id: uuidv4(), type: 'defuse' });
    }

    // Add Kaboom Kitties
    // Rule: playerCount - 1 Kaboom Kitties
    for (let i = 0; i < playerCount - 1; i++) {
      this.cards.push({ id: uuidv4(), type: 'kaboom' });
    }

    // Shuffle again with Defuses and Kabooms
    this.shuffle();
  }

  public shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j]!, this.cards[i]!];
    }
  }

  public draw(): Card | undefined {
    return this.cards.pop(); // Returns undefined if deck is empty
  }

  public insertAt(card: Card, index: number) {
    // Determine exact index based on 0 (top of deck) to N (bottom of deck)
    // Actually, pop() takes from the end, so the "top" of the deck is the end of the array.
    // Let's say top of deck is array length - 1, bottom is 0.
    // For ease of mental model: index 0 = top of deck, index N = bottom.
    
    // Convert index where 0 is top.
    const realIndex = this.cards.length - index;
    // ensure realIndex is between 0 and this.cards.length
    const boundedIndex = Math.max(0, Math.min(this.cards.length, realIndex));

    this.cards.splice(boundedIndex, 0, card);
  }

  public peek(count: number): Card[] {
    // Peak at the top `count` cards. Top of deck is the end of array.
    return this.cards.slice(-count).reverse();
  }

  public get count() {
    return this.cards.length;
  }
}
