require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const PORT = process.env.PORT || 3001;
// In production, you should set CORS_ORIGIN to your Vercel URL
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();

// Security: Trust proxy (needed for Render to get real IPs)
app.set("trust proxy", 1);

// Security: Add HTTP headers
app.use(helmet());

// Security: Rate limiting
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per `window`
  message: "Too many requests, please try again later."
});
app.use(apiLimiter);

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
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

// Simple socket rate limiting
const socketMessageCounts = new Map();

io.on("connection", (socket) => {
  // Rate limit cleanup interval per socket
  socketMessageCounts.set(socket.id, 0);
  const rlInterval = setInterval(() => {
    socketMessageCounts.set(socket.id, 0);
  }, 1000);

  // Helper to check rate limit
  const isRateLimited = () => {
    const count = (socketMessageCounts.get(socket.id) || 0) + 1;
    socketMessageCounts.set(socket.id, count);
    if (count > 50) { // Max 50 messages per second per socket
      console.log(`[!] Disconnecting socket due to rate limit abuse`);
      socket.disconnect(true);
      return true;
    }
    return false;
  };

  console.log(`[+] Socket connected (ID scrubbed for privacy)`);

  // --- Room management ---
  socket.on("join-room", (payload, callback) => {
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
        const rMembers = rooms.get(r);
        if (rMembers) {
          if (rMembers.sender === socket.id) rMembers.sender = null;
          if (rMembers.receiver === socket.id) rMembers.receiver = null;
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

    if (isRateLimited()) return;
    
    console.log(`[~] Peer joined room as ${requestedRole} (Room ID scrubbed)`);

    callback?.({ ok: true, role: requestedRole, roomId: roomId_clean, peerCount });

    // Notify the other peer (if any) that someone joined
    socket.to(roomId_clean).emit("peer-joined");
  });

  // --- WebRTC signaling relay ---
  socket.on("offer", (payload) => {
    if (isRateLimited()) return;
    const { roomId, offer } = payload;
    if (!roomId || !offer) return;
    console.log(`[~] Relaying offer...`);
    socket.to(roomId).emit("offer", { offer });
  });

  socket.on("answer", (payload) => {
    if (isRateLimited()) return;
    const { roomId, answer } = payload;
    if (!roomId || !answer) return;
    console.log(`[~] Relaying answer...`);
    socket.to(roomId).emit("answer", { answer });
  });

  socket.on("ice-candidate", (payload) => {
    if (isRateLimited()) return;
    const { roomId, candidate } = payload;
    if (!roomId || !candidate) return;
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  socket.on("resume", (payload) => {
    if (isRateLimited()) return;
    const { roomId, index } = payload;
    if (!roomId || index === undefined) return;
    console.log(`[~] Relaying resume-from chunk...`);
    socket.to(roomId).emit("resume", { index });
  });

  socket.on("reconnect-signal", (payload) => {
    if (isRateLimited()) return;
    const { roomId } = payload;
    if (!roomId) return;
    console.log(`[~] Relaying reconnect signal...`);
    socket.to(roomId).emit("reconnect-signal");
  });

  socket.on("fallback-relay", (payload) => {
    if (isRateLimited()) return;
    const { roomId } = payload;
    if (!roomId) return;
    console.log(`[~] Room falling back to WebSocket Relay mode`);
    socket.to(roomId).emit("fallback-relay");
  });

  socket.on("relay-data", (payload) => {
    if (isRateLimited()) return;
    const { roomId, data } = payload;
    if (!roomId || data === undefined) return;
    socket.to(roomId).emit("relay-data", data);
  });

  // --- Disconnect handling ---
  socket.on("disconnect", (reason) => {
    clearInterval(rlInterval);
    socketMessageCounts.delete(socket.id);
    console.log(`[-] Socket disconnected (${reason})`);

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
          console.log(`[~] Room deleted (empty)`);
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
  console.log(`\n🚀 Hosted signaling server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
