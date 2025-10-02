const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve static files
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));

// Store active rooms and users
const rooms = new Map();

// Store media rooms and their state
const mediaRooms = new Map();

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

      if (!rooms.has(roomName)) rooms.set(roomName, new Map());
      const room = rooms.get(roomName);

      // Add/update user
      room.set(socket.id, {
        id: socket.id,
        displayName: displayName || `User${socket.id.substring(0, 6)}`
      });

      console.log(`📊 Room ${roomName} has ${room.size} users`);

      // Get existing users (excluding self)
      const otherUsers = Array.from(room.values()).filter(user => user.id !== socket.id);
      socket.emit('room-joined', otherUsers);

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

  // Media sharing room handlers
  socket.on('join-media-room', (roomName, displayName) => {
    try {
      console.log(`🎬 ${socket.id} joining media room ${roomName} as ${displayName}`);

      // Leave previous media rooms
      for (const r of socket.rooms) {
        if (r.startsWith('media-')) socket.leave(r);
      }

      const mediaRoomName = `media-${roomName}`;
      socket.join(mediaRoomName);

      if (!mediaRooms.has(mediaRoomName)) {
        // First user in the room becomes host
        mediaRooms.set(mediaRoomName, {
          participants: new Map(),
          queue: [],
          currentMedia: null,
          hostId: socket.id
        });
      }

      const mediaRoom = mediaRooms.get(mediaRoomName);
      const isHost = mediaRoom.hostId === socket.id;

      // Add participant
      mediaRoom.participants.set(socket.id, {
        id: socket.id,
        name: displayName || `User${socket.id.substring(0, 6)}`,
        isHost: isHost
      });

      console.log(`📊 Media room ${roomName} has ${mediaRoom.participants.size} participants`);

      // Send current room state to the joining user
      socket.emit('media-room-joined', {
        isHost: isHost,
        participants: Object.fromEntries(mediaRoom.participants),
        queue: mediaRoom.queue,
        currentMedia: mediaRoom.currentMedia
      });

      // Notify others about new participant
      socket.to(mediaRoomName).emit('media-user-joined', {
        userId: socket.id,
        user: {
          id: socket.id,
          name: displayName || `User${socket.id.substring(0, 6)}`,
          isHost: isHost
        }
      });

    } catch (err) {
      console.error('❌ Error join-media-room:', err);
      socket.emit('error', { message: 'Failed to join media room' });
    }
  });

  socket.on('leave-media-room', (roomName) => {
    const mediaRoomName = `media-${roomName}`;
    handleMediaUserLeave(mediaRoomName, socket.id);
  });

  // Media control handlers
  socket.on('media-load', (data) => {
    const mediaRoomName = `media-${data.room}`;
    if (mediaRooms.has(mediaRoomName)) {
      const mediaRoom = mediaRooms.get(mediaRoomName);
      
      // Only host can load media
      if (mediaRoom.hostId === socket.id) {
        mediaRoom.currentMedia = data.media;
        socket.to(mediaRoomName).emit('media-load', {
          media: data.media
        });
      }
    }
  });

  socket.on('media-play', (data) => {
    const mediaRoomName = `media-${data.room}`;
    if (mediaRooms.has(mediaRoomName)) {
      const mediaRoom = mediaRooms.get(mediaRoomName);
      
      // Only host can control playback
      if (mediaRoom.hostId === socket.id) {
        socket.to(mediaRoomName).emit('media-play', {
          timestamp: data.timestamp
        });
      }
    }
  });

  socket.on('media-pause', (data) => {
    const mediaRoomName = `media-${data.room}`;
    if (mediaRooms.has(mediaRoomName)) {
      const mediaRoom = mediaRooms.get(mediaRoomName);
      
      // Only host can control playback
      if (mediaRoom.hostId === socket.id) {
        socket.to(mediaRoomName).emit('media-pause');
      }
    }
  });

  socket.on('media-sync-request', (data) => {
    const mediaRoomName = `media-${data.room}`;
    if (mediaRooms.has(mediaRoomName)) {
      const mediaRoom = mediaRooms.get(mediaRoomName);
      
      // Only host can respond to sync requests
      if (mediaRoom.hostId === socket.id) {
        // In a real implementation, you'd get the current playback state
        // For now, we'll send a simple response
        socket.emit('media-sync-response', {
          timestamp: 0,
          isPlaying: false
        });
      } else {
        // Forward the sync request to the host
        socket.to(mediaRoom.hostId).emit('media-sync-request', {
          requesterId: socket.id
        });
      }
    }
  });

  socket.on('media-queue-update', (data) => {
    const mediaRoomName = `media-${data.room}`;
    if (mediaRooms.has(mediaRoomName)) {
      const mediaRoom = mediaRooms.get(mediaRoomName);
      
      // Only host can update queue
      if (mediaRoom.hostId === socket.id) {
        mediaRoom.queue = data.queue;
        socket.to(mediaRoomName).emit('media-queue-update', {
          queue: data.queue
        });
      }
    }
  });

  socket.on('media-chat-message', (data) => {
    const mediaRoomName = `media-${data.room}`;
    socket.to(mediaRoomName).emit('media-chat-message', {
      message: data.message,
      userId: socket.id,
      userName: data.userName
    });
  });

  // Screen sharing events
  socket.on('screen-share-started', (data) => {
    const mediaRoomName = `media-${data.room}`;
    socket.to(mediaRoomName).emit('screen-share-started', {
      hasAudio: data.hasAudio
    });
  });

  socket.on('screen-share-stopped', (data) => {
    const mediaRoomName = `media-${data.room}`;
    socket.to(mediaRoomName).emit('screen-share-stopped');
  });

  // WebRTC handlers (existing)
  socket.on('offer', (data) => {
    socket.to(data.to).emit('offer', {
      offer: data.offer,
      from: socket.id
    });
  });

  socket.on('answer', (data) => {
    socket.to(data.to).emit('answer', {
      answer: data.answer,
      from: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.to).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.id
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

  socket.on('update-display-name', (data) => {
    if (rooms.has(data.room)) {
      const roomData = rooms.get(data.room);
      if (roomData.has(socket.id)) {
        roomData.get(socket.id).displayName = data.displayName;
      }
    }
    socket.to(data.room).emit('update-display-name', {
      userId: socket.id,
      displayName: data.displayName
    });
  });

  socket.on('leave-room', (roomName) => handleUserLeave(roomName, socket.id));
  
  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
    
    // Handle video room leave
    rooms.forEach((users, roomName) => {
      if (users.has(socket.id)) handleUserLeave(roomName, socket.id);
    });
    
    // Handle media room leave
    mediaRooms.forEach((mediaRoom, mediaRoomName) => {
      if (mediaRoom.participants.has(socket.id)) {
        handleMediaUserLeave(mediaRoomName, socket.id);
      }
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

  function handleMediaUserLeave(mediaRoomName, userId) {
    if (!mediaRooms.has(mediaRoomName)) return;
    
    const mediaRoom = mediaRooms.get(mediaRoomName);
    const wasHost = mediaRoom.hostId === userId;
    
    if (mediaRoom.participants.has(userId)) {
      const userName = mediaRoom.participants.get(userId).name;
      mediaRoom.participants.delete(userId);
      
      console.log(`⬅️ ${userId} (${userName}) left media room ${mediaRoomName}`);
      
      // Notify others
      socket.to(mediaRoomName).emit('media-user-left', {
        userId: userId,
        wasHost: wasHost
      });
      
      // If host left, assign new host
      if (wasHost && mediaRoom.participants.size > 0) {
        // Assign first participant as new host
        const newHostId = Array.from(mediaRoom.participants.keys())[0];
        mediaRoom.hostId = newHostId;
        mediaRoom.participants.get(newHostId).isHost = true;
        
        // Notify new host
        io.to(newHostId).emit('media-room-joined', {
          isHost: true,
          participants: Object.fromEntries(mediaRoom.participants),
          queue: mediaRoom.queue,
          currentMedia: mediaRoom.currentMedia
        });
        
        console.log(`👑 New host assigned: ${newHostId}`);
      }
      
      // Clean up empty media rooms
      if (mediaRoom.participants.size === 0) {
        mediaRooms.delete(mediaRoomName);
        console.log(`🗑️ Media room ${mediaRoomName} deleted (empty)`);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
