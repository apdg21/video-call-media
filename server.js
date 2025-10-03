const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));

const rooms = new Map();

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  socket.on('join-room', (roomName, displayName) => {
    try {
      console.log(`🎯 ${socket.id} joining room ${roomName} as ${displayName}`);

      // Leave previous rooms
      for (const r of socket.rooms) {
        if (r !== socket.id) socket.leave(r);
      }

      socket.join(roomName);

      if (!rooms.has(roomName)) {
        rooms.set(roomName, new Map());
      }
      const room = rooms.get(roomName);

      // Add/update user
      room.set(socket.id, {
        id: socket.id,
        displayName: displayName || `User${socket.id.substring(0, 6)}`,
        joinedAt: Date.now()
      });

      console.log(`📊 Room ${roomName} has ${room.size} users`);

      // Get existing users (excluding self)
      const otherUsers = Array.from(room.values()).filter(user => user.id !== socket.id);
      
      // Send room info to the new user
      socket.emit('room-joined', {
        users: otherUsers,
        room: roomName
      });

      // Notify others about new user
      socket.to(roomName).emit('user-connected', {
        id: socket.id,
        displayName: displayName || `User${socket.id.substring(0, 6)}`
      });

    } catch (err) {
      console.error('❌ Error join-room:', err);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  socket.on('offer', (data) => {
    console.log(`📤 Offer from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit('offer', {
      offer: data.offer,
      from: socket.id,
      room: data.room
    });
  });

  socket.on('answer', (data) => {
    console.log(`📤 Answer from ${socket.id} to ${data.to}`);
    socket.to(data.to).emit('answer', {
      answer: data.answer,
      from: socket.id,
      room: data.room
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.to).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.id,
      room: data.room
    });
  });

  socket.on('chat-message', (data) => {
    socket.to(data.room).emit('chat-message', {
      message: data.message,
      userId: socket.id,
      userName: data.userName
    });
  });

  socket.on('user-media-update', (data) => {
    socket.to(data.room).emit('user-media-update', {
      userId: socket.id,
      video: data.video,
      audio: data.audio
    });
  });

  socket.on('request-reconnect', (data) => {
    console.log(`🔄 ${socket.id} requesting reconnect with ${data.targetUser}`);
    socket.to(data.targetUser).emit('reconnect-request', {
      from: socket.id
    });
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
    rooms.forEach((users, roomName) => {
      if (users.has(socket.id)) {
        const userName = users.get(socket.id).displayName;
        users.delete(socket.id);
        console.log(`⬅️ ${socket.id} (${userName}) left room ${roomName}`);
        socket.to(roomName).emit('user-disconnected', socket.id);
        if (users.size === 0) {
          rooms.delete(roomName);
          console.log(`🗑️ Room ${roomName} deleted (empty)`);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
