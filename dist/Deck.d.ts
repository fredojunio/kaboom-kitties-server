import { Card, CardType } from './types.js';
export declare class Deck {
    cards: Card[];
    constructor(playerCount?: number);
    /**
     * Builds the standard deck based on the 59 action/kitty cards rule.
     * Total = playerCount - 1 Kabooms, playerCount + 4 Defuses, and 59 Actions/Kitties.
     */
    private buildStandardDeck;
    /**
     * Creates the base pool of 92 action and kitty cards.
     */
    buildActionPool(): void;
    addCards(type: CardType, count: number): void;
    shuffle(): void;
    draw(): Card | undefined;
    insertAt(card: Card, index: number): void;
    peek(count: number): Card[];
    get count(): number;
}
