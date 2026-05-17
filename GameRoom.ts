import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { ActionType, Card, CardType, ClientGameState, ClientPlayer, GameState, Player, PendingAction } from './types.js';
import { Deck } from './Deck.js';

const NOPE_WINDOW_MS = 3000;

export class GameRoom {
  public state: GameState;
  private io: Server;
  private deck: Deck | null = null;
  private nopeTimeout: NodeJS.Timeout | null = null;
  private turnTimeout: NodeJS.Timeout | null = null;
  private onEmpty: () => void;
  private emptyTimeout: NodeJS.Timeout | null = null;
  private readonly CLEANUP_DELAY = 120000; // 2 minutes

  constructor(roomCode: string, io: Server, onEmpty: () => void) {
    this.onEmpty = onEmpty;
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
      activeKaboom: null,
      pendingFavor: null,
      winnerId: null,
      turnExpiresAt: null,
      actionLog: [],
    };
  }

  private addToLog(message: string) {
    this.state.actionLog.push({
      message,
      timestamp: Date.now()
    });
    // Keep only last 50 logs to prevent state bloating
    if (this.state.actionLog.length > 50) {
      this.state.actionLog.shift();
    }
  }

  // CONNECTION MANAGEMENT
  public addPlayer(id: string, name: string) {
    const existing = this.state.players.find(p => p.id === id);

    if (this.state.status !== 'lobby') {
      if (existing) {
        existing.connected = true;
        if (existing.disconnectTimeout) clearTimeout(existing.disconnectTimeout);
        this.broadcastState();
        return;
      }
      throw new Error('Game already started');
    }

    if (this.state.players.length >= 14 && !existing) throw new Error('Room is full');
    
    // Clear cleanup timeout if anyone joins
    this.clearEmptyTimeout();

    if (!existing) {
      this.state.players.push({
        id,
        name,
        hand: [],
        isEliminated: false,
        connected: true,
      });
    } else {
      existing.connected = true;
      existing.name = name;
    }
    this.broadcastState();
  }

  public handleDisconnect(playerId: string) {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;

    player.connected = false;

    // Check if room is now empty
    this.checkEmptiness();

    this.broadcastState();
  }

  private checkEmptiness() {
    const connectedPlayers = this.state.players.filter(p => p.connected);
    if (connectedPlayers.length === 0) {
      if (!this.emptyTimeout) {
        console.log(`Room ${this.state.roomCode} is empty. Scheduling cleanup...`);
        this.emptyTimeout = setTimeout(() => {
          console.log(`Room ${this.state.roomCode} cleaned up due to inactivity.`);
          this.onEmpty();
        }, this.CLEANUP_DELAY);
      }
    }
  }

  public clearEmptyTimeout() {
    if (this.emptyTimeout) {
      console.log(`Room ${this.state.roomCode} active again. Cleanup cancelled.`);
      clearTimeout(this.emptyTimeout);
      this.emptyTimeout = null;
    }
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

    // 1. Create the action pool (59 cards)
    this.deck = new Deck();
    this.deck.buildActionPool();

    // 2. Deal 4 action cards + 1 Defuse to each player
    // Each player gets 1 defuse (total N defuses given to players)
    this.state.players.forEach(p => {
      p.hand = [
        { id: uuidv4(), type: 'defuse' }
      ];
      for (let i = 0; i < 4; i++) {
        const c = this.deck!.draw();
        if (c) p.hand.push(c);
      }
    });

    // 3. Add remaining Defuses and Kabooms to the deck
    // total defuses = playerCount + 4. N are already with players, so add 4 to deck.
    this.deck.addCards('defuse', 4);
    // total kabooms = playerCount - 1
    this.deck.addCards('kaboom', this.state.players.length - 1);

    // 4. Shuffle the final deck
    this.deck.shuffle();

    this.state.drawPileCount = this.deck.count;
    this.state.status = 'playing';
    this.state.currentPlayerIndex = 0;
    this.state.turnsRemaining = 1;

    this.addToLog('Game started!');
    this.io.to(this.state.roomCode).emit('game_started');
    this.resetTurnTimer();
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
    this.resetTurnTimer();
  }

  private eliminatePlayer(playerId: string) {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.isEliminated) return;

    player.isEliminated = true;
    player.hand = []; // Discard hand

    this.io.to(this.state.roomCode).emit('player_eliminated', { playerId });
    this.addToLog(`${player.name} was eliminated!`);
    
    // After elimination, check if game is over
    if (this.checkGameOver()) return;

    // If it was the eliminated player's turn, move to next turn
    if (this.state.players[this.state.currentPlayerIndex].id === playerId) {
      // Force remaining turns to 1 so nextTurn() accurately passes to the next alive player
      this.state.turnsRemaining = 1; 
      this.nextTurn();
    }
    this.broadcastState();
  }

  private checkGameOver(): boolean {
    const remaining = this.state.players.filter(p => !p.isEliminated);
    
    if (remaining.length <= 1) {
      this.clearTurnTimer();
      // Delay game over by 3 seconds so players can see the last explosion
      setTimeout(() => {
        this.state.status = 'finished';
        this.state.winnerId = remaining.length === 1 ? remaining[0].id : null;
        if (this.state.winnerId) {
          const winner = this.state.players.find(p => p.id === this.state.winnerId);
          this.addToLog(`${winner?.name || 'Someone'} won the game!`);
        }
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
    
    // Validate target for Demand and Fate Switch
    if ((card.type === 'demand' || card.type === 'fate_switch') && !targetPlayerId) throw new Error(`${card.type} requires a target`);

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

    this.removeCardsFromHand(player, [cardId]);
    this.state.discardPile.push(card);

    this.state.pendingAction.nopeCount++;
    this.addToLog(`${player.name} played NOPE!`);
    // Reset timer
    this.resetNopeTimer();
    this.broadcastState();
  }

  // ACTIONS ENGINE
  private queueAction(action: PendingAction) {
    this.clearTurnTimer();
    this.state.pendingAction = action;
    
    // Log the initial play
    const player = this.state.players.find(p => p.id === action.originalPlayerId);
    const target = this.state.players.find(p => p.id === action.targetPlayerId);
    
    if (player) {
      if (action.actionType === 'play_card') {
        const cardId = action.cardIds?.[0];
        const type = this.state.discardPile.find(c => c.id === cardId)?.type;
        const msg = target 
          ? `${player.name} played ${type} on ${target.name}` 
          : `${player.name} played ${type}`;
        this.addToLog(msg);
      } else if (action.actionType === 'play_combo') {
        const count = action.cardIds?.length || 2;
        const type = count === 2 ? 'Pair' : 'Trio';
        const msg = `${player.name} played ${type} on ${target?.name || 'someone'}`;
        this.addToLog(msg);
      }
    }

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

    if (isCancelled) {
      this.addToLog('Action was NOPED');
    }

    if (!isCancelled) {
      this.executeAction(action);
    }
    
    this.resetTurnTimer();
  }

  private executeAction(action: PendingAction) {
    if (action.actionType === 'play_card') {
      const cardId = action.cardIds?.[0];
      const card = this.state.discardPile.find(c => c.id === cardId);
      const type = card?.type;
      
      if (!type) return;
      
      switch (type) {
        case 'skip':
          this.nextTurn();
          break;
        case 'attack':
          const addedTurns = this.state.turnsRemaining > 1 ? this.state.turnsRemaining + 2 : 2;
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
          const attacker = this.state.players.find(p => p.id === action.originalPlayerId);
          if (target && attacker && target.hand.length > 0) {
            // Enter Favor Selection mode
            this.state.pendingFavor = {
              attackerId: attacker.id,
              targetId: target.id,
              attackerName: attacker.name
            };
          }
          break;
        }
        case 'fate_switch': {
          const target = this.state.players.find(p => p.id === action.targetPlayerId);
          const attacker = this.state.players.find(p => p.id === action.originalPlayerId);
          if (target && attacker) {
            const temp = attacker.hand;
            attacker.hand = target.hand;
            target.hand = temp;
            
            // Add custom log for the swap
            this.addToLog(`${attacker.name} swapped hands with ${target.name}!`);
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

    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.isEliminated) throw new Error('Player is eliminated');

    const card = this.deck!.draw();
    this.state.drawPileCount = this.deck!.count;
    
    if (!card) throw new Error('Deck empty'); // Edge case, should not happen

    if (card.type === 'kaboom') {
      this.handleKaboom(playerId, card);
    } else {
      player.hand.push(card);
      this.addToLog(`${player.name} drew a card`);
      this.io.to(this.state.roomCode).emit('card_drawn', { playerId });
      
      // End turn safely
      this.nextTurn();
    }
  }

  public giveFavor(playerId: string, cardId: string) {
    if (!this.state.pendingFavor) throw new Error('No favor pending');
    const { attackerId, targetId } = this.state.pendingFavor;
    
    if (targetId !== playerId) throw new Error('Not your favor to give');

    const target = this.state.players.find(p => p.id === playerId);
    const attacker = this.state.players.find(p => p.id === attackerId);
    
    if (!target || !attacker) throw new Error('Players not found');

    const cardIdx = target.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) throw new Error('Card not in hand');

    const stolen = target.hand.splice(cardIdx, 1)[0];
    attacker.hand.push(stolen);

    this.state.pendingFavor = null;
    this.resetTurnTimer();
  }

  private handleKaboom(playerId: string, card: Card) {
    this.clearTurnTimer();
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;

    this.io.to(this.state.roomCode).emit('kaboom_drawn', { playerId });
    this.addToLog(`${player.name} drew a KABOOM KITTEN!`);
    this.state.activeKaboom = card;

    const defuseIdx = player.hand.findIndex(c => c.type === 'defuse');
    if (defuseIdx === -1) {
      // Broadcast state so they see the kaboom on table
      this.broadcastState();

      // Delay elimination by 2 seconds so they see the card
      setTimeout(() => {
        // Double check if player is still there and eliminated
        if (this.state.status !== 'playing') return;
        this.eliminatePlayer(playerId);
        this.state.discardPile.push(card);
        this.state.activeKaboom = null;
        this.broadcastState();
      }, 2000);
    } else {
      // Auto play defuse (No Nope Window)
      const defuse = player.hand.splice(defuseIdx, 1)[0];
      this.state.discardPile.push(defuse);
      
      // Wait for player to insert kaboom back (in UI)
      this.io.to(playerId).emit('await_defuse_insert', { card: this.state.activeKaboom });
      this.state.activeKaboom = null;
      this.broadcastState();
    }
  }

  public insertDefusedKaboom(playerId: string, index: number, card: Card) {
    // Allows player to insert a defused kaboom back
    // Must be their turn and they must be waiting to insert
    this.deck!.insertAt(card, index);
    this.state.drawPileCount++;
    this.addToLog(`${this.state.players.find(p => p.id === playerId)?.name} defused the kitten!`);
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
      discardHistory: this.state.discardPile.map(c => c.type),
      pendingAction: this.getSanitizedPendingAction(this.state.pendingAction),
      activeKaboom: this.state.activeKaboom,
      pendingFavor: this.state.pendingFavor,
      winnerId: this.state.winnerId,
      turnExpiresAt: this.state.turnExpiresAt,
      myHand: me ? me.hand : [],
      spectatorDeck: (me?.isEliminated && this.deck) ? [...this.deck.cards].reverse() : undefined,
      actionLog: this.state.actionLog
    };
  }

  public broadcastState() {
    this.state.players.forEach(p => {
      if (p.connected) {
        this.io.to(p.id).emit('game_state', this.getSanitizedStateForPlayer(p.id));
      }
    });
  }

  private resetTurnTimer() {
    if (this.turnTimeout) {
      clearTimeout(this.turnTimeout);
      this.turnTimeout = null;
    }

    if (this.state.status !== 'playing' || this.state.pendingAction || this.state.activeKaboom || this.state.pendingFavor || this.state.players.filter(p => !p.isEliminated).length <= 1) {
      this.state.turnExpiresAt = null;
      return;
    }

    const currentPlayer = this.state.players[this.state.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.isEliminated) {
      this.state.turnExpiresAt = null;
      return;
    }

    const duration = 15000;
    this.state.turnExpiresAt = Date.now() + duration;

    this.turnTimeout = setTimeout(() => {
      if (this.state.status === 'playing' && !this.state.pendingAction && !this.state.activeKaboom && !this.state.pendingFavor) {
        this.addToLog(`${currentPlayer.name} didn't act in time. Auto-drawing...`);
        try {
          this.drawCard(currentPlayer.id);
        } catch (e) {
          console.error('Auto draw error:', e);
        }
      }
    }, duration);

    this.broadcastState();
  }

  private clearTurnTimer() {
    if (this.turnTimeout) {
      clearTimeout(this.turnTimeout);
      this.turnTimeout = null;
    }
    this.state.turnExpiresAt = null;
  }
}
