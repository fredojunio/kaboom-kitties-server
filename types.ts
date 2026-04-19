export type CardType = 
  | 'defuse'
  | 'kaboom'
  | 'skip'
  | 'attack'
  | 'peek'
  | 'shuffle'
  | 'demand'
  | 'nope'
  | 'taco_cat'
  | 'beard_cat'
  | 'cattermelon'
  | 'hairy_potato_cat'
  | 'rainbow_ralphing_cat';

export interface Card {
  id: string; // Unique UUID
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

export type ActionType = 
  | 'play_card'
  | 'play_combo'
  | 'draw';

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
  turnsRemaining: number; // usually 1, increased by attacks
  drawPileCount: number;
  discardPile: Card[];
  pendingAction: PendingAction | null;
  activeKaboom: Card | null;
  pendingFavor: { attackerId: string, targetId: string, attackerName: string } | null;
  winnerId: string | null;
}

// Client-view state (sanitized so they don't see others' hands/draw pile exact)
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
  pendingAction: {
    id: string;
    originalPlayerId: string;
    actionType: ActionType;
    cards: Card[]; // Actually show cards being played for Nope window
    targetPlayerId?: string;
    nopeCount: number;
  } | null;
  pendingFavor: { attackerId: string, targetId: string, attackerName: string } | null;
  winnerId: string | null;
  myHand: Card[];
}
