require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const PORT = process.env.PORT || 3001;

const app = express();

// Security: Trust Ngrok proxy to get real IPs for rate limiting
app.set("trust proxy", 1);

// Security: Add HTTP headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled to prevent blocking React/WebSockets
}));

// Security: Rate limiting to prevent DDoS via Ngrok
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per `window`
  message: "Too many requests, please try again later."
});
app.use(apiLimiter);

app.use(cors());
app.use(express.json());

// Serve the compiled React app.
// distPath is injected by main.js so it works both in dev (inside source tree)
// and in the packaged app (unpacked outside the ASAR archive).
const distPath = global.electronDistPath || path.join(__dirname, "dist");
console.log(`[server] Serving static files from: ${distPath}`);
app.use(express.static(distPath));

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

// SPA fallback: for any route that isn't a static asset or API,
// serve index.html so React Router (if used) handles it client-side.
// This must come AFTER all explicit API routes.
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
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

    if (isRateLimited()) return;
    
    console.log(
      `[~] Peer joined room as ${requestedRole} (Room ID scrubbed)`
    );

    callback?.({ ok: true, role: requestedRole, roomId: roomId_clean, peerCount });

    // Notify the other peer (if any) that someone joined
    socket.to(roomId_clean).emit("peer-joined");
  });

  // --- WebRTC signaling relay ---

  // Sender creates offer, sends it to the server, server relays to receiver
  socket.on("offer", (payload) => {
    if (isRateLimited()) return;
    const { roomId, offer } = payload;
    if (!roomId || !offer) return;
    console.log(`[~] Relaying offer...`);
    socket.to(roomId).emit("offer", { offer });
  });

  // Receiver creates answer, server relays back to sender
  socket.on("answer", (payload) => {
    if (isRateLimited()) return;
    const { roomId, answer } = payload;
    if (!roomId || !answer) return;
    console.log(`[~] Relaying answer...`);
    socket.to(roomId).emit("answer", { answer });
  });

  // Both sides relay ICE candidates through the server
  socket.on("ice-candidate", (payload) => {
    if (isRateLimited()) return;
    const { roomId, candidate } = payload;
    if (!roomId || !candidate) return;
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  // Churn recovery: relay resume-from signal via signaling server
  // (fallback for when data channel is not yet re-established)
  socket.on("resume", (payload) => {
    if (isRateLimited()) return;
    const { roomId, index } = payload;
    if (!roomId || index === undefined) return;
    console.log(`[~] Relaying resume-from chunk...`);
    socket.to(roomId).emit("resume", { index });
  });

  // Manual reconnect: tell the peer to restart WebRTC
  socket.on("reconnect-signal", (payload) => {
    if (isRateLimited()) return;
    const { roomId } = payload;
    if (!roomId) return;
    console.log(`[~] Relaying reconnect signal...`);
    socket.to(roomId).emit("reconnect-signal");
  });

  // Fallback to WebSocket relay mode
  socket.on("fallback-relay", (payload) => {
    if (isRateLimited()) return;
    const { roomId } = payload;
    if (!roomId) return;
    console.log(`[~] Room falling back to WebSocket Relay mode`);
    socket.to(roomId).emit("fallback-relay");
  });

  // Relay data directly (WebSocket fallback)
  socket.on("relay-data", (payload) => {
    if (isRateLimited()) return;
    const { roomId, data } = payload;
    if (!roomId || data === undefined) return;
    // Don't log this to avoid console spam during high-speed transfers
    socket.to(roomId).emit("relay-data", data);
  });

  // --- Disconnect handling ---
  socket.on("disconnect", (reason) => {
    clearInterval(rlInterval);
    socketMessageCounts.delete(socket.id);
    console.log(`[-] Socket disconnected (${reason})`);

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

// Export a promise that resolves once the server is bound and ready.
// main.js awaits this before creating the BrowserWindow to avoid race conditions.
const serverReady = new Promise((resolve) => {
  httpServer.listen(PORT, () => {
    console.log(`\n🚀 Signaling server running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health\n`);
    resolve(PORT);
  });
});

module.exports = { serverReady };
