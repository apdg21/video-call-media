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
const mediaRooms = new Map();

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  // Video call room events
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
      socket.emit('error', { message: `Cannot send offer: user ${data.to} not found in room ${data.room}` });
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
      socket.emit('error', { message: `Cannot send answer: user ${data.to} not found in room ${data.room}` });
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
      socket.emit('error', { message: `Cannot send ICE candidate: user ${data.to} not found in room ${data.room}` });
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

  // ============ MEDIA SHARING EVENTS ============
  
  socket.on('join-media-room', (roomName, displayName) => {
    try {
      console.log(`🎬 ${socket.id} joining media room ${roomName} as ${displayName}`);
      
      // Leave any other media rooms
      for (const r of socket.rooms) {
        if (r.startsWith('media-')) socket.leave(r);
      }
      
      const mediaRoomId = `media-${roomName}`;
      socket.join(mediaRoomId);
      
      if (!mediaRooms.has(mediaRoomId)) {
        mediaRooms.set(mediaRoomId, new Map());
        console.log(`🎯 Created new media room: ${roomName}`);
      }
      
      const mediaRoom = mediaRooms.get(mediaRoomId);
      const isFirstUser = mediaRoom.size === 0;
      
      mediaRoom.set(socket.id, {
        id: socket.id,
        displayName: displayName || `User${socket.id.substring(0, 6)}`,
        isHost: isFirstUser // First user becomes host
      });
      
      console.log(`📊 Media room ${roomName} has ${mediaRoom.size} users`);
      
      const users = Array.from(mediaRoom.values());
      const hostId = isFirstUser ? socket.id : Array.from(mediaRoom.values()).find(user => user.isHost)?.id;
      
      // Send current users to the joining user
      socket.emit('media-room-joined', users, hostId);
      
      // Notify other users in the media room
      socket.to(mediaRoomId).emit('media-user-connected', {
        id: socket.id,
        displayName: displayName || `User${socket.id.substring(0, 6)}`,
        isHost: isFirstUser
      });
      
    } catch (err) {
      console.error('❌ Error join-media-room:', err);
      socket.emit('error', { message: 'Failed to join media room' });
    }
  });

  socket.on('leave-media-room', (roomName) => {
    handleMediaUserLeave(roomName, socket.id);
  });

  socket.on('media-become-host', (roomName) => {
    const mediaRoomId = `media-${roomName}`;
    if (!mediaRooms.has(mediaRoomId)) return;
    
    const mediaRoom = mediaRooms.get(mediaRoomId);
    if (mediaRoom.has(socket.id)) {
      // Remove host from current host
      mediaRoom.forEach((user, userId) => {
        user.isHost = userId === socket.id;
      });
      
      // Notify all users in the media room
      io.to(mediaRoomId).emit('media-host-changed', socket.id);
      console.log(`👑 ${socket.id} became host in media room ${roomName}`);
    }
  });

  socket.on('media-control', (data) => {
  const mediaRoomId = `media-${data.room}`;
  if (!mediaRooms.has(mediaRoomId)) {
    console.warn(`Media control for non-existent room: ${data.room}`);
    return;
  }
  
  const mediaRoom = mediaRooms.get(mediaRoomId);
  const user = mediaRoom.get(socket.id);
  
  // Only allow hosts to control media
  if (user && user.isHost) {
    console.log(`🎮 Media control from host ${socket.id} in room ${data.room}:`, data.type);
    
    // Broadcast media control to all other users in the media room
    socket.to(mediaRoomId).emit('media-control', {
      ...data,
      from: socket.id
    });
  } else {
    console.warn(`❌ Non-host ${socket.id} attempted media control in room ${data.room}`);
  }
});

  socket.on('media-chat-message', (data) => {
    const mediaRoomId = `media-${data.room}`;
    if (!mediaRooms.has(mediaRoomId)) {
      console.warn(`Media chat for non-existent room: ${data.room}`);
      return;
    }
    
    console.log(`💬 Media chat from ${socket.id} in room ${data.room}`);
    
    // Broadcast media chat message to all other users in the media room
    socket.to(mediaRoomId).emit('media-chat-message', {
      message: data.message,
      userId: socket.id,
      userName: data.userName
    });
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
    
    // Handle video call room cleanup
    rooms.forEach((users, roomName) => {
      if (users.has(socket.id)) handleUserLeave(roomName, socket.id);
    });
    
    // Handle media room cleanup
    mediaRooms.forEach((users, mediaRoomId) => {
      if (users.has(socket.id)) {
        const roomName = mediaRoomId.replace('media-', '');
        handleMediaUserLeave(roomName, socket.id);
      }
    });
  });

  function handleMediaUserLeave(roomName, userId) {
    const mediaRoomId = `media-${roomName}`;
    if (!mediaRooms.has(mediaRoomId)) return;
    
    const mediaRoom = mediaRooms.get(mediaRoomId);
    if (mediaRoom.has(userId)) {
      const user = mediaRoom.get(userId);
      const wasHost = user.isHost;
      
      mediaRoom.delete(userId);
      console.log(`⬅️ ${userId} (${user.displayName}) left media room ${roomName}`);
      
      // Notify other users
      socket.to(mediaRoomId).emit('media-user-disconnected', userId);
      
      // If host left and there are other users, assign new host
      if (wasHost && mediaRoom.size > 0) {
        const newHost = Array.from(mediaRoom.values())[0]; // First user becomes new host
        newHost.isHost = true;
        
        io.to(mediaRoomId).emit('media-host-changed', newHost.id);
        console.log(`👑 ${newHost.id} (${newHost.displayName}) became new host in media room ${roomName}`);
      }
      
      if (mediaRoom.size === 0) {
        mediaRooms.delete(mediaRoomId);
        console.log(`🗑️ Media room ${roomName} deleted (empty)`);
      }
    }
  }

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
