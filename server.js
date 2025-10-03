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
      for (const r of socket.rooms) {
        if (r !== socket.id) socket.leave(r);
      }
      socket.join(roomName);
      if (!rooms.has(roomName)) rooms.set(roomName, new Map());
      const room = rooms.get(roomName);
      room.set(socket.id, {
        id: socket.id,
        displayName: displayName || `User${socket.id.substring(0, 6)}`
      });
      console.log(`📊 Room ${roomName} has ${room.size} users`);
      const otherUsers = Array.from(room.values()).filter(user => user.id !== socket.id);
      socket.emit('room-joined', otherUsers);
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
    if (!rooms.has(data.room) || !rooms.get(data.room).has(data.to)) {
      console.warn(`Invalid offer: room ${data.room} or user ${data.to} not found`);
      return;
    }
    socket.to(data.to).emit('offer', {
      offer: data.offer,
      from: socket.id,
      room: data.room
    });
  });

  socket.on('answer', (data) => {
    if (!rooms.has(data.room) || !rooms.get(data.room).has(data.to)) {
      console.warn(`Invalid answer: room ${data.room} or user ${data.to} not found`);
      return;
    }
    socket.to(data.to).emit('answer', {
      answer: data.answer,
      from: socket.id,
      room: data.room
    });
  });

  socket.on('ice-candidate', (data) => {
    if (!rooms.has(data.room) || !rooms.get(data.room).has(data.to)) {
      console.warn(`Invalid ICE candidate: room ${data.room} or user ${data.to} not found`);
      return;
    }
    socket.to(data.to).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.id,
      room: data.room
    });
  });

  socket.on('chat-message', (data) => {
    if (!rooms.has(data.room)) return;
    socket.to(data.room).emit('chat-message', {
      message: data.message,
      userId: socket.id,
      userName: data.userName
    });
  });

  socket.on('user-media-update', (data) => {
    if (!rooms.has(data.room)) return;
    socket.to(data.room).emit('user-media-update', {
      userId: socket.id,
      video: data.video,
      audio: data.audio
    });
  });

  socket.on('leave-room', (roomName) => handleUserLeave(roomName, socket.id));
  
  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
    rooms.forEach((users, roomName) => {
      if (users.has(socket.id)) handleUserLeave(roomName, socket.id);
    });
  });

  function handleUserLeave(roomName, userId) {
    if (!rooms.has(roomName)) return;
    const room = rooms.get(roomName);
    if (room.has(userId)) {
      const userName = room.get(userId).displayName;
      room.delete(userId);
      console.log(`⬅️ ${userId} (${userName}) left room ${roomName}`);
      socket.to(roomName).emit('user-disconnected', userId);
      if (room.size === 0) {
        rooms.delete(roomName);
        console.log(`🗑️ Room ${roomName} deleted (empty)`);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
