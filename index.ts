import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { GameRoom } from './GameRoom.js';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms: Record<string, GameRoom> = {};

function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms[code]);
  return code;
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Create game
  socket.on('create_room', ({ playerName }) => {
    try {
      const roomCode = generateRoomCode();
      rooms[roomCode] = new GameRoom(roomCode, io, () => {
        delete rooms[roomCode];
      });
      socket.join(roomCode);
      rooms[roomCode].addPlayer(socket.id, playerName);
      socket.emit('room_created', { roomCode });
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  // Join game
  socket.on('join_room', ({ roomCode, playerName }) => {
    try {
      const room = rooms[roomCode];
      if (!room) throw new Error('Room not found');
      socket.join(roomCode);
      room.addPlayer(socket.id, playerName);
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  // Reconnect
  socket.on('reconnect_room', ({ roomCode, playerId }) => {
    try {
      const room = rooms[roomCode];
      if (!room) throw new Error('Room not found');
      
      // Update socket id of player? 
      // Socket.IO actually replaces socket.id on reconnection.
      // We should swap old id to new id in GameRoom or just use stable playerId.
      // For simplicity here, let's treat socket.id as stable for the session or if they provide old playerId, replace their connection.
      const player = room.state.players.find(p => p.id === playerId);
      if (player) {
        player.id = socket.id; // Update ID to current socket
        socket.join(roomCode);
        player.connected = true;
        if (player.disconnectTimeout) clearTimeout(player.disconnectTimeout);
        room.broadcastState();
      } else {
        throw new Error('Player not found in room');
      }
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('start_game', ({ roomCode }) => {
    try {
      rooms[roomCode]?.startGame(socket.id);
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  // Play Actions
  socket.on('play_card', ({ roomCode, cardId, targetPlayerId }) => {
    try {
      rooms[roomCode]?.playCard(socket.id, cardId, targetPlayerId);
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('play_combo', ({ roomCode, cardIds, targetPlayerId, namedCard }) => {
    try {
      rooms[roomCode]?.playCombo(socket.id, cardIds, targetPlayerId, namedCard);
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('play_nope', ({ roomCode, pendingActionId, cardId }) => {
    try {
      rooms[roomCode]?.playNope(socket.id, pendingActionId, cardId);
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('draw_card', ({ roomCode }) => {
    try {
      rooms[roomCode]?.drawCard(socket.id);
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('insert_defuse', ({ roomCode, index, card }) => {
    try {
      rooms[roomCode]?.insertDefusedKaboom(socket.id, index, card);
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('kick_player', ({ roomCode, targetPlayerId }) => {
    try {
      const room = rooms[roomCode];
      if (!room) throw new Error('Room not found');
      
      // Only host can kick (first player in list)
      const isHost = room.state.players[0]?.id === socket.id;
      if (!isHost) throw new Error('Only the host can kick players');
      
      room.kickPlayer(targetPlayerId);
    } catch (e: any) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('disconnect', () => {
    // Find rooms player is in and handle disconnect
    Object.values(rooms).forEach(room => {
      room.handleDisconnect(socket.id);
    });
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
