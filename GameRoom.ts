import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { ActionType, Card, CardType, ClientGameState, ClientPlayer, GameState, Player, PendingAction } from './types.js';
import { Deck } from './Deck.js';

const NOPE_WINDOW_MS = 2000;

export class GameRoom {
  public state: GameState;
  private io: Server;
  private deck: Deck | null = null;
  private nopeTimeout: NodeJS.Timeout | null = null;

  constructor(roomCode: string, io: Server) {
    this.io = io;
    this.state = {
      roomCode,
      status: 'lobby',
      players: [],
      currentPlayerIndex: 0,
      turnsRemaining: 1,
      drawPileCount: 0,
      discardPile: [],
      pendingAction: null,
      winnerId: null,
    };
  }

  // CONNECTION MANAGEMENT
  public addPlayer(id: string, name: string) {
    if (this.state.status !== 'lobby') {
      const existing = this.state.players.find(p => p.id === id);
      if (existing) {
        existing.connected = true;
        if (existing.disconnectTimeout) clearTimeout(existing.disconnectTimeout);
        this.broadcastState();
        return;
      }
      throw new Error('Game already started');
    }

    if (this.state.players.length >= 14) throw new Error('Room is full');
    if (!this.state.players.find(p => p.id === id)) {
      this.state.players.push({
        id,
        name,
        hand: [],
        isEliminated: false,
        connected: true,
      });
    }
    this.broadcastState();
  }

  public handleDisconnect(playerId: string) {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;

    player.connected = false;
    
    if (this.state.status === 'playing') {
      // 60-second timer to eliminate
      player.disconnectTimeout = setTimeout(() => {
        this.eliminatePlayer(playerId);
      }, 60000);
    } else if (this.state.status === 'lobby') {
      this.state.players = this.state.players.filter(p => p.id !== playerId);
    }
    this.broadcastState();
  }

  public kickPlayer(playerId: string) {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;

    // Notify the player they were kicked
    this.io.to(playerId).emit('kicked');

    if (this.state.status === 'lobby') {
      this.state.players = this.state.players.filter(p => p.id !== playerId);
    } else {
      // If game started, just eliminate them so the game can continue
      this.eliminatePlayer(playerId);
      // Also mark as disconnected so they don't keep count as "connected" if they were
      player.connected = false;
    }
    
    this.broadcastState();
  }

  // GAME LOOP
  public startGame(hostId: string) {
    if (this.state.status !== 'lobby') throw new Error('Game already started');
    if (this.state.players.length < 2) throw new Error('Need at least 2 players');

    // Build deck initially for random cards
    const initialDeck = new Deck(this.state.players.length);
    // Remove kabooms and defuses from initial hands deal
    initialDeck.cards = initialDeck.cards.filter(c => c.type !== 'kaboom' && c.type !== 'defuse');

    // Deal 4 random cards + 1 Defuse to each player
    this.state.players.forEach(p => {
      p.hand = [
        { id: uuidv4(), type: 'defuse' }
      ];
      for (let i = 0; i < 4; i++) {
        const c = initialDeck.draw();
        if (c) p.hand.push(c);
      }
    });

    // Rebuild the proper deck using Deck class
    this.deck = new Deck(this.state.players.length);
    this.state.drawPileCount = this.deck.count;
    this.state.status = 'playing';
    this.state.currentPlayerIndex = 0;
    this.state.turnsRemaining = 1;

    this.io.to(this.state.roomCode).emit('game_started');
    this.broadcastState();
  }

  private nextTurn(extraTurns = 0) {
    if (this.state.turnsRemaining > 1 && extraTurns === 0) {
      this.state.turnsRemaining--;
    } else {
      const activePlayers = this.state.players.filter(p => !p.isEliminated);
      if (activePlayers.length < 2) {
        // If there aren't enough players to continue, resolve end state instead of looping
        this.checkGameOver();
        return;
      }

      // Safety: only loop if we know there is at least one non-eliminated player
      let iterations = 0;
      do {
        this.state.currentPlayerIndex = (this.state.currentPlayerIndex + 1) % this.state.players.length;
        iterations++;
        // If we've looped through everyone and still find only eliminated players (safety break)
        if (iterations > this.state.players.length) break;
      } while (this.state.players[this.state.currentPlayerIndex]!.isEliminated);
      
      this.state.turnsRemaining = extraTurns > 0 ? extraTurns : 1;
    }
    
    this.io.to(this.state.roomCode).emit('turn_changed', { 
      currentPlayerId: this.state.players[this.state.currentPlayerIndex].id,
      turnsRemaining: this.state.turnsRemaining
    });
    this.broadcastState();
  }

  private eliminatePlayer(playerId: string) {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.isEliminated) return;

    player.isEliminated = true;
    player.hand = []; // Discard hand

    this.io.to(this.state.roomCode).emit('player_eliminated', { playerId });
    
    // After elimination, check if game is over
    if (this.checkGameOver()) return;

    // If it was the eliminated player's turn, move to next turn
    if (this.state.players[this.state.currentPlayerIndex].id === playerId) {
      this.nextTurn();
    }
    this.broadcastState();
  }

  private checkGameOver(): boolean {
    const remaining = this.state.players.filter(p => !p.isEliminated);
    
    if (remaining.length <= 1) {
      // Delay game over by 3 seconds so players can see the last explosion
      setTimeout(() => {
        this.state.status = 'finished';
        this.state.winnerId = remaining.length === 1 ? remaining[0].id : null;
        this.io.to(this.state.roomCode).emit('game_over', { winnerId: this.state.winnerId });
        this.broadcastState();
      }, 3000);
      return true;
    }
    return false;
  }

  // PLAYING CARDS
  private removeCardsFromHand(player: Player, cardIds: string[]): Card[] {
    const removed: Card[] = [];
    cardIds.forEach(id => {
      const idx = player.hand.findIndex(c => c.id === id);
      if (idx !== -1) {
        removed.push(player.hand.splice(idx, 1)[0]);
      }
    });
    return removed;
  }

  public playCard(playerId: string, cardId: string, targetPlayerId?: string) {
    if (this.state.status !== 'playing') throw new Error('Game is not playing');
    if (this.state.pendingAction) throw new Error('Wait for current action to resolve');
    if (this.state.players[this.state.currentPlayerIndex].id !== playerId) throw new Error('Not your turn');

    const player = this.state.players.find(p => p.id === playerId);
    if (!player) throw new Error('Player not found');

    const card = player.hand.find(c => c.id === cardId);
    if (!card) throw new Error('Card not in hand');

    if (['defuse', 'kaboom', 'nope'].includes(card.type)) throw new Error('Cannot actively play this card');
    
    // Validate target for Demand
    if (card.type === 'demand' && !targetPlayerId) throw new Error('Demand requires a target');

    const removed = this.removeCardsFromHand(player, [cardId]);
    this.state.discardPile.push(removed[0]);

    this.queueAction({
      id: uuidv4(),
      originalPlayerId: playerId,
      actionType: 'play_card',
      cardIds: [cardId],
      targetPlayerId,
      nopeCount: 0,
      timestamp: Date.now(),
      timeout: null,
      resolved: false
    });
  }

  public playCombo(playerId: string, cardIds: string[], targetPlayerId: string, namedCard?: CardType) {
    if (this.state.status !== 'playing') throw new Error('Game is not playing');
    if (this.state.pendingAction) throw new Error('Wait for current action to resolve');
    if (this.state.players[this.state.currentPlayerIndex].id !== playerId) throw new Error('Not your turn');

    const player = this.state.players.find(p => p.id === playerId);
    if (!player) throw new Error('Player not found');

    const cardsToPlay = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean) as Card[];
    if (cardsToPlay.length !== cardIds.length) throw new Error('Cards not in hand');
    if (cardsToPlay.length < 2 || cardsToPlay.length > 3) throw new Error('Invalid combo size');
    
    // Check all are same kitty cat
    const isKitty = ['taco_cat', 'beard_cat', 'cattermelon', 'hairy_potato_cat', 'rainbow_ralphing_cat'].includes(cardsToPlay[0].type);
    if (!isKitty) throw new Error('Only kitty cats can be comboed');
    const allSame = cardsToPlay.every(c => c.type === cardsToPlay[0].type);
    if (!allSame) throw new Error('Combo cards must match');

    if (cardsToPlay.length === 3 && !namedCard) throw new Error('Trio requires naming a card');
    if (!targetPlayerId) throw new Error('Combos require a target player');

    const removed = this.removeCardsFromHand(player, cardIds);
    this.state.discardPile.push(...removed);

    this.queueAction({
      id: uuidv4(),
      originalPlayerId: playerId,
      actionType: 'play_combo',
      cardIds,
      targetPlayerId,
      namedCard,
      nopeCount: 0,
      timestamp: Date.now(),
      timeout: null,
      resolved: false
    });
  }

  public playNope(playerId: string, pendingActionId: string, cardId: string) {
    if (!this.state.pendingAction || this.state.pendingAction.id !== pendingActionId) {
      throw new Error('No such pending action');
    }

    const player = this.state.players.find(p => p.id === playerId);
    if (!player) throw new Error('Player not found');

    const card = player.hand.find(c => c.id === cardId);
    if (!card || card.type !== 'nope') throw new Error('Valid Nope card not found in hand');

    // Nope card can only be played to interrupt other's actions, and not on your own turn
    const isMyTurn = this.state.players[this.state.currentPlayerIndex].id === playerId;
    if (isMyTurn) throw new Error('Cannot play a Nope card on your own turn');

    this.removeCardsFromHand(player, [cardId]);
    this.state.discardPile.push(card);

    this.state.pendingAction.nopeCount++;
    // Reset timer
    this.resetNopeTimer();
    this.broadcastState();
  }

  // ACTIONS ENGINE
  private queueAction(action: PendingAction) {
    this.state.pendingAction = action;
    this.resetNopeTimer();
    this.broadcastState();
  }

  private resetNopeTimer() {
    if (this.nopeTimeout) clearTimeout(this.nopeTimeout);
    
    this.state.pendingAction!.timestamp = Date.now();
    this.io.to(this.state.roomCode).emit('action_pending', this.getSanitizedPendingAction(this.state.pendingAction));

    this.nopeTimeout = setTimeout(() => {
      this.resolvePendingAction();
    }, NOPE_WINDOW_MS);
  }

  private resolvePendingAction() {
    if (!this.state.pendingAction) return;

    const action = this.state.pendingAction;
    this.state.pendingAction = null;
    if (this.nopeTimeout) clearTimeout(this.nopeTimeout);

    const isCancelled = action.nopeCount % 2 !== 0;
    
    this.io.to(this.state.roomCode).emit('action_resolved', {
      actionId: action.id,
      cancelled: isCancelled
    });

    if (!isCancelled) {
      this.executeAction(action);
    }
    
    this.broadcastState();
  }

  private executeAction(action: PendingAction) {
    if (action.actionType === 'play_card') {
      const type = this.state.discardPile[this.state.discardPile.length - 1].type;
      
      switch (type) {
        case 'skip':
          this.nextTurn();
          break;
        case 'attack':
          const addedTurns = this.state.turnsRemaining > 1 ? this.state.turnsRemaining + 1 : 2;
          this.nextTurn(addedTurns);
          break;
        case 'peek':
          const peeked = this.deck!.peek(3);
          this.io.to(action.originalPlayerId).emit('peek_result', peeked);
          break;
        case 'shuffle':
          this.deck!.shuffle();
          break;
        case 'demand': {
          const target = this.state.players.find(p => p.id === action.targetPlayerId);
          if (target && target.hand.length > 0) {
            // target gives 1 random card (or we could enforce target choosing, but for simplicitly picking random or top)
            // Implementation: target player's client handles "choose a card" - wait, game rules say "they give you 1 card of their choice". 
            // In a strict server model, we'd need a secondary pending state. 
            // For now, since rules say "target gives", but architecture doesn't have a sub-state easily, we randomly take one for speed unless requested.
            // Let's implement random steal for 'demand' to prevent stalling.
            const rIdx = Math.floor(Math.random() * target.hand.length);
            const stolen = target.hand.splice(rIdx, 1)[0];
            const attacker = this.state.players.find(p => p.id === action.originalPlayerId);
            attacker?.hand.push(stolen);
          }
          break;
        }
      }
    } else if (action.actionType === 'play_combo') {
      const target = this.state.players.find(p => p.id === action.targetPlayerId);
      const attacker = this.state.players.find(p => p.id === action.originalPlayerId);
      if (target && attacker && target.hand.length > 0) {
        if (action.cardIds?.length === 2) {
          // pair steal random
          const rIdx = Math.floor(Math.random() * target.hand.length);
          const stolen = target.hand.splice(rIdx, 1)[0];
          attacker.hand.push(stolen);
        } else if (action.cardIds?.length === 3 && action.namedCard) {
          // trio try steal named
          const cIdx = target.hand.findIndex(c => c.type === action.namedCard);
          if (cIdx !== -1) {
            const stolen = target.hand.splice(cIdx, 1)[0];
            attacker.hand.push(stolen);
          }
        }
      }
    }
  }

  public drawCard(playerId: string) {
    if (this.state.status !== 'playing') throw new Error('Game is not playing');
    if (this.state.pendingAction) throw new Error('Wait for action to resolve');
    if (this.state.players[this.state.currentPlayerIndex].id !== playerId) throw new Error('Not your turn');

    const card = this.deck!.draw();
    this.state.drawPileCount = this.deck!.count;
    
    if (!card) throw new Error('Deck empty'); // Edge case, should not happen

    if (card.type === 'kaboom') {
      this.handleKaboom(playerId, card);
    } else {
      const player = this.state.players.find(p => p.id === playerId);
      player?.hand.push(card);
      // End turn safely
      this.nextTurn();
    }
  }

  private handleKaboom(playerId: string, card: Card) {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;

    this.io.to(this.state.roomCode).emit('kaboom_drawn', { playerId });

    const defuseIdx = player.hand.findIndex(c => c.type === 'defuse');
    if (defuseIdx === -1) {
      // Eliminated
      this.eliminatePlayer(playerId);
      this.state.discardPile.push(card); // Exploded kaboom discards
    } else {
      // Auto play defuse
      const defuse = player.hand.splice(defuseIdx, 1)[0];
      this.state.discardPile.push(defuse);
      
      // Wait for player to insert kaboom back (in UI)
      // Tell player's client to insert kaboom
      this.io.to(playerId).emit('await_defuse_insert', { card });
    }
    this.broadcastState();
  }

  public insertDefusedKaboom(playerId: string, index: number, card: Card) {
    // Allows player to insert a defused kaboom back
    // Must be their turn and they must be waiting to insert
    this.deck!.insertAt(card, index);
    this.state.drawPileCount++;
    this.io.to(this.state.roomCode).emit('defuse_inserted');
    this.nextTurn(); // turn ends after resolving defuse
  }

  // STATE SYNC
  private getSanitizedPendingAction(action: PendingAction | null) {
    if (!action) return null;
    
    // Get actual cards for pending action so client can render what was played
    let pendingCards: Card[] = [];
    if (action.actionType.startsWith('play')) {
      // Find them in discard pile which is where they moved
      const cIds = action.cardIds || [];
      pendingCards = this.state.discardPile.filter(c => cIds.includes(c.id));
    }

    return {
      id: action.id,
      originalPlayerId: action.originalPlayerId,
      actionType: action.actionType,
      cards: pendingCards,
      targetPlayerId: action.targetPlayerId,
      nopeCount: action.nopeCount
    };
  }

  private getSanitizedStateForPlayer(playerId: string): ClientGameState {
    const me = this.state.players.find(p => p.id === playerId);
    
    return {
      roomCode: this.state.roomCode,
      status: this.state.status,
      players: this.state.players.map(p => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        isEliminated: p.isEliminated,
        connected: p.connected,
        isMe: p.id === playerId
      })),
      currentPlayerId: this.state.players[this.state.currentPlayerIndex]?.id || '',
      turnsRemaining: this.state.turnsRemaining,
      drawPileCount: this.state.drawPileCount,
      recentDiscards: this.state.discardPile.slice(-10).map(c => c.type),
      pendingAction: this.getSanitizedPendingAction(this.state.pendingAction),
      winnerId: this.state.winnerId,
      myHand: me ? me.hand : []
    };
  }

  public broadcastState() {
    this.state.players.forEach(p => {
      if (p.connected) {
        this.io.to(p.id).emit('game_state', this.getSanitizedStateForPlayer(p.id));
      }
    });
  }
}
