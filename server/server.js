const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Track rooms: roomId -> [socketId, ...]
const rooms = new Map();

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    rooms: rooms.size,
    connections: io.engine.clientsCount,
  });
});

io.on("connection", (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // --- Room management ---
  socket.on("join-room", (payload, callback) => {
    // payload can be a string (legacy) or an object { id, role }
    let roomId, requestedRole;
    if (typeof payload === "string") {
      roomId = payload;
    } else {
      roomId = payload.id;
      requestedRole = payload.role;
    }

    if (!roomId || typeof roomId !== "string") {
      return callback?.({ error: "Invalid room ID" });
    }

    const roomId_clean = roomId.trim().toUpperCase();
    const room = rooms.get(roomId_clean) || { sender: null, receiver: null };

    // Check if the requested role is already taken
    if (requestedRole) {
      if (room[requestedRole]) {
        return callback?.({ error: `Role '${requestedRole}' is already taken in this room` });
      }
    } else {
      // Legacy behavior: auto-assign role
      if (!room.sender && !room.receiver) requestedRole = "sender";
      else if (!room.receiver) requestedRole = "receiver";
      else if (!room.sender) requestedRole = "sender";
      else return callback?.({ error: "Room is full (max 2 peers)" });
    }

    // Leave any previous rooms this socket was in
    socket.rooms.forEach((r) => {
      if (r !== socket.id) {
        socket.leave(r);
        // Remove this socket from the room tracking
        const rMembers = rooms.get(r);
        if (rMembers) {
          if (rMembers.sender === socket.id) rMembers.sender = null;
          if (rMembers.receiver === socket.id) rMembers.receiver = null;
          // If room is empty, delete it
          if (!rMembers.sender && !rMembers.receiver) rooms.delete(r);
          else rooms.set(r, rMembers);
        }
        socket.to(r).emit("peer-disconnected");
      }
    });

    socket.join(roomId_clean);
    room[requestedRole] = socket.id;
    rooms.set(roomId_clean, room);

    const peerCount = (room.sender ? 1 : 0) + (room.receiver ? 1 : 0);

    console.log(
      `[~] ${socket.id} joined room ${roomId_clean} as ${requestedRole}`
    );

    callback?.({ ok: true, role: requestedRole, roomId: roomId_clean, peerCount });

    // Notify the other peer (if any) that someone joined
    socket.to(roomId_clean).emit("peer-joined");
  });

  // --- WebRTC signaling relay ---

  // Sender creates offer, sends it to the server, server relays to receiver
  socket.on("offer", (payload) => {
    const { roomId, offer } = payload;
    if (!roomId || !offer) return;
    console.log(`[~] Relaying offer in room ${roomId}`);
    socket.to(roomId).emit("offer", { offer });
  });

  // Receiver creates answer, server relays back to sender
  socket.on("answer", (payload) => {
    const { roomId, answer } = payload;
    if (!roomId || !answer) return;
    console.log(`[~] Relaying answer in room ${roomId}`);
    socket.to(roomId).emit("answer", { answer });
  });

  // Both sides relay ICE candidates through the server
  socket.on("ice-candidate", (payload) => {
    const { roomId, candidate } = payload;
    if (!roomId || !candidate) return;
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  // Churn recovery: relay resume-from signal via signaling server
  // (fallback for when data channel is not yet re-established)
  socket.on("resume", (payload) => {
    const { roomId, index } = payload;
    if (!roomId || index === undefined) return;
    console.log(`[~] Relaying resume-from chunk ${index} in room ${roomId}`);
    socket.to(roomId).emit("resume", { index });
  });

  // Manual reconnect: tell the peer to restart WebRTC
  socket.on("reconnect-signal", (payload) => {
    const { roomId } = payload;
    if (!roomId) return;
    console.log(`[~] Relaying reconnect signal in room ${roomId}`);
    socket.to(roomId).emit("reconnect-signal");
  });

  // --- Disconnect handling ---
  socket.on("disconnect", (reason) => {
    console.log(`[-] Socket disconnected: ${socket.id} (${reason})`);

    // Remove from all rooms and notify peers
    rooms.forEach((room, roomId) => {
      let changed = false;
      if (room.sender === socket.id) {
        room.sender = null;
        changed = true;
      }
      if (room.receiver === socket.id) {
        room.receiver = null;
        changed = true;
      }
      
      if (changed) {
        if (!room.sender && !room.receiver) {
          rooms.delete(roomId);
          console.log(`[~] Room ${roomId} deleted (empty)`);
        } else {
          rooms.set(roomId, room);
          io.to(roomId).emit("peer-disconnected");
          console.log(`[~] Notified room ${roomId} of disconnect`);
        }
      }
    });
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🚀 Signaling server running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
