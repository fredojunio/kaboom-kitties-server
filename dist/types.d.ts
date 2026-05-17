export type CardType = 'defuse' | 'kaboom' | 'skip' | 'attack' | 'peek' | 'shuffle' | 'demand' | 'nope' | 'taco_cat' | 'beard_cat' | 'cattermelon' | 'hairy_potato_cat' | 'rainbow_ralphing_cat' | 'fate_switch';
export interface Card {
    id: string;
    type: CardType;
}
export interface Player {
    id: string;
    name: string;
    hand: Card[];
    isEliminated: boolean;
    connected: boolean;
    disconnectTimeout?: NodeJS.Timeout;
}
export type ActionType = 'play_card' | 'play_combo' | 'draw';
export interface PendingAction {
    id: string;
    originalPlayerId: string;
    actionType: ActionType;
    cardIds?: string[];
    targetPlayerId?: string;
    namedCard?: CardType;
    nopeCount: number;
    timestamp: number;
    timeout: NodeJS.Timeout | null;
    resolved: boolean;
}
export interface GameState {
    roomCode: string;
    status: 'lobby' | 'playing' | 'finished';
    players: Player[];
    currentPlayerIndex: number;
    turnsRemaining: number;
    drawPileCount: number;
    discardPile: Card[];
    pendingAction: PendingAction | null;
    activeKaboom: Card | null;
    pendingFavor: {
        attackerId: string;
        targetId: string;
        attackerName: string;
    } | null;
    winnerId: string | null;
    turnExpiresAt: number | null;
    actionLog: {
        message: string;
        timestamp: number;
    }[];
}
export interface ClientPlayer {
    id: string;
    name: string;
    cardCount: number;
    isEliminated: boolean;
    connected: boolean;
    isMe: boolean;
}
export interface ClientGameState {
    roomCode: string;
    status: 'lobby' | 'playing' | 'finished';
    players: ClientPlayer[];
    currentPlayerId: string;
    turnsRemaining: number;
    drawPileCount: number;
    recentDiscards: CardType[];
    discardHistory: CardType[];
    pendingAction: {
        id: string;
        originalPlayerId: string;
        actionType: ActionType;
        cards: Card[];
        targetPlayerId?: string;
        nopeCount: number;
    } | null;
    activeKaboom: Card | null;
    pendingFavor: {
        attackerId: string;
        targetId: string;
        attackerName: string;
    } | null;
    winnerId: string | null;
    turnExpiresAt: number | null;
    myHand: Card[];
    spectatorDeck?: Card[];
    actionLog: {
        message: string;
        timestamp: number;
    }[];
}
