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
  socket.on("join-room", (roomId, callback) => {
    if (!roomId || typeof roomId !== "string") {
      return callback?.({ error: "Invalid room ID" });
    }

    const roomId_clean = roomId.trim().toUpperCase();
    const existing = rooms.get(roomId_clean) || [];

    if (existing.length >= 2) {
      console.log(`[!] Room ${roomId_clean} is full`);
      return callback?.({ error: "Room is full (max 2 peers)" });
    }

    // Leave any previous rooms this socket was in
    socket.rooms.forEach((r) => {
      if (r !== socket.id) {
        socket.leave(r);
        const members = rooms.get(r) || [];
        rooms.set(r, members.filter((id) => id !== socket.id));
        socket.to(r).emit("peer-disconnected");
      }
    });

    socket.join(roomId_clean);
    existing.push(socket.id);
    rooms.set(roomId_clean, existing);

    const isSender = existing.length === 1;
    console.log(
      `[~] ${socket.id} joined room ${roomId_clean} as ${isSender ? "sender" : "receiver"}`
    );

    callback?.({ ok: true, role: isSender ? "sender" : "receiver", roomId: roomId_clean });

    // Notify the first peer that a second peer has connected
    if (!isSender) {
      socket.to(roomId_clean).emit("peer-joined");
    }
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

  // --- Disconnect handling ---
  socket.on("disconnect", (reason) => {
    console.log(`[-] Socket disconnected: ${socket.id} (${reason})`);

    // Remove from all rooms and notify peers
    rooms.forEach((members, roomId) => {
      if (members.includes(socket.id)) {
        const updated = members.filter((id) => id !== socket.id);
        if (updated.length === 0) {
          rooms.delete(roomId);
          console.log(`[~] Room ${roomId} deleted (empty)`);
        } else {
          rooms.set(roomId, updated);
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
