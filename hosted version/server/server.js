require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const crypto  = require("crypto");
const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors    = require("cors");
const helmet  = require("helmet");
const rateLimit = require("express-rate-limit");

const PORT = process.env.PORT || 3001;
// Set CORS_ORIGIN to your Vercel frontend URL in Railway env vars.
// Falls back to '*' only for local development.
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// ─── Structured logger ────────────────────────────────────────────────────────
const hashRoom = (id) =>
  crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 8);

const log = (level, event, meta = {}) => {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }) + "\n"
  );
};

// ─── Input validation constants ───────────────────────────────────────────────
const ROOM_ID_RE  = /^[A-Z0-9]{4,12}$/;
const VALID_ROLES = new Set(["sender", "receiver"]);

// ─── ICE server config ────────────────────────────────────────────────────────
const iceConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    {
      urls:       (process.env.TURN_URLS || "turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443,turn:openrelay.metered.ca:443?transport=tcp").split(","),
      username:   process.env.TURN_USERNAME   || "openrelayproject",
      credential: process.env.TURN_CREDENTIAL || "openrelayproject",
    },
  ],
};

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

app.set("trust proxy", 1);

app.use(helmet());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
}));

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "16kb" }));

// ─── HTTP endpoints ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: rooms.size, connections: io.engine.clientsCount });
});

app.get("/api/ice-config", (_req, res) => {
  res.json(iceConfig);
});

// ─── HTTP server + Socket.io ───────────────────────────────────────────────────
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
  maxHttpBufferSize: 96 * 1024,
});

// ─── Room state ───────────────────────────────────────────────────────────────
const rooms = new Map();

const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(id);
      log("info", "room.expired", { room: hashRoom(id) });
    }
  }
}, 5 * 60 * 1000);

// ─── Per-IP connection cap ─────────────────────────────────────────────────────
const ipConnections = new Map();
const MAX_CONNS_PER_IP = 5;

// ─── Socket.io connection handler ─────────────────────────────────────────────
io.on("connection", (socket) => {
  const ip = socket.handshake.address;

  const connCount = (ipConnections.get(ip) || 0) + 1;
  if (connCount > MAX_CONNS_PER_IP) {
    log("warn", "ratelimit.conn_cap", { ip_hash: hashRoom(ip) });
    socket.disconnect(true);
    return;
  }
  ipConnections.set(ip, connCount);

  let msgCount = 0;
  let relayBytesThisWindow = 0;
  const rlInterval = setInterval(() => {
    msgCount = 0;
    relayBytesThisWindow = 0;
  }, 1000);

  const isRateLimited = () => {
    msgCount++;
    if (msgCount > 50) {
      log("warn", "ratelimit.msg_rate", { socket: socket.id.slice(0, 8) });
      socket.disconnect(true);
      return true;
    }
    return false;
  };

  const isMemberOf = (roomId) => socket.rooms.has(roomId);

  log("info", "socket.connected");

  // ── join-room ──────────────────────────────────────────────────────────────
  socket.on("join-room", (payload, callback) => {
    let roomId        = typeof payload === "string" ? payload : payload?.id;
    let requestedRole = typeof payload === "object" ? payload?.role : undefined;

    const roomId_clean = String(roomId || "").trim().toUpperCase();
    if (!ROOM_ID_RE.test(roomId_clean)) {
      log("warn", "validation.roomid_reject");
      return callback?.({ error: "Invalid room ID" });
    }

    if (requestedRole !== undefined && !VALID_ROLES.has(requestedRole)) {
      log("warn", "validation.role_reject");
      return callback?.({ error: "Invalid role" });
    }

    const room = rooms.get(roomId_clean) || { sender: null, receiver: null, createdAt: Date.now() };

    if (requestedRole) {
      if (room[requestedRole]) {
        return callback?.({ error: `Role '${requestedRole}' is already taken in this room` });
      }
    } else {
      if      (!room.sender   && !room.receiver) requestedRole = "sender";
      else if (!room.receiver)                   requestedRole = "receiver";
      else if (!room.sender)                     requestedRole = "sender";
      else return callback?.({ error: "Room is full (max 2 peers)" });
    }

    for (const r of socket.rooms) {
      if (r === socket.id) continue;
      socket.leave(r);
      const prev = rooms.get(r);
      if (prev) {
        if (prev.sender   === socket.id) prev.sender   = null;
        if (prev.receiver === socket.id) prev.receiver = null;
        if (!prev.sender && !prev.receiver) rooms.delete(r);
        else rooms.set(r, prev);
      }
      socket.to(r).emit("peer-disconnected");
    }

    socket.join(roomId_clean);
    room[requestedRole] = socket.id;
    rooms.set(roomId_clean, room);

    const peerCount = (room.sender ? 1 : 0) + (room.receiver ? 1 : 0);

    if (isRateLimited()) return;

    log("info", "room.join", { room: hashRoom(roomId_clean), role: requestedRole, peers: peerCount });

    callback?.({ ok: true, role: requestedRole, roomId: roomId_clean, peerCount });
    socket.to(roomId_clean).emit("peer-joined");
  });

  // ── WebRTC signaling relay ─────────────────────────────────────────────────
  socket.on("offer", (payload) => {
    if (isRateLimited()) return;
    const { roomId, offer } = payload || {};
    if (!roomId || !offer || !isMemberOf(roomId)) return;
    if (JSON.stringify(offer).length > 8192) return;
    socket.to(roomId).emit("offer", { offer });
  });

  socket.on("answer", (payload) => {
    if (isRateLimited()) return;
    const { roomId, answer } = payload || {};
    if (!roomId || !answer || !isMemberOf(roomId)) return;
    if (JSON.stringify(answer).length > 8192) return;
    socket.to(roomId).emit("answer", { answer });
  });

  socket.on("ice-candidate", (payload) => {
    if (isRateLimited()) return;
    const { roomId, candidate } = payload || {};
    if (!roomId || !candidate || !isMemberOf(roomId)) return;
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  socket.on("resume", (payload) => {
    if (isRateLimited()) return;
    const { roomId, index } = payload || {};
    if (!roomId || index === undefined || !isMemberOf(roomId)) return;
    socket.to(roomId).emit("resume", { index });
  });

  socket.on("reconnect-signal", (payload) => {
    if (isRateLimited()) return;
    const { roomId } = payload || {};
    if (!roomId || !isMemberOf(roomId)) return;
    log("info", "signal.reconnect", { room: hashRoom(roomId) });
    socket.to(roomId).emit("reconnect-signal");
  });

  socket.on("fallback-relay", (payload) => {
    if (isRateLimited()) return;
    const { roomId } = payload || {};
    if (!roomId || !isMemberOf(roomId)) return;
    log("info", "signal.fallback_relay", { room: hashRoom(roomId) });
    socket.to(roomId).emit("fallback-relay");
  });

  const MAX_RELAY_FRAME_BYTES = 96 * 1024;
  const MAX_RELAY_BYTES_PER_SEC = 20 * 1024 * 1024;

  socket.on("relay-data", (roomId, data) => {
    if (!roomId || data === undefined || !isMemberOf(roomId)) return;

    const frameSize = data?.byteLength ?? (typeof data === "string" ? data.length : 0);

    if (frameSize > MAX_RELAY_FRAME_BYTES) {
      log("warn", "ratelimit.relay_frame_too_large", { bytes: frameSize });
      socket.disconnect(true);
      return;
    }

    relayBytesThisWindow += frameSize;
    if (relayBytesThisWindow > MAX_RELAY_BYTES_PER_SEC) {
      log("warn", "ratelimit.relay_bandwidth", { socket: socket.id.slice(0, 8) });
      socket.disconnect(true);
      return;
    }

    socket.to(roomId).emit("relay-data", data);
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    clearInterval(rlInterval);

    const count = (ipConnections.get(ip) || 1) - 1;
    if (count <= 0) ipConnections.delete(ip);
    else ipConnections.set(ip, count);

    log("info", "socket.disconnected", { reason });

    rooms.forEach((room, roomId) => {
      let changed = false;
      if (room.sender   === socket.id) { room.sender   = null; changed = true; }
      if (room.receiver === socket.id) { room.receiver = null; changed = true; }

      if (changed) {
        if (!room.sender && !room.receiver) {
          rooms.delete(roomId);
          log("info", "room.destroyed", { room: hashRoom(roomId) });
        } else {
          rooms.set(roomId, room);
          io.to(roomId).emit("peer-disconnected");
          log("info", "room.peer_left", { room: hashRoom(roomId) });
        }
      }
    });
  });
});

httpServer.listen(PORT, () => {
  log("info", "server.listening", { port: PORT });
  console.log(`\n🚀 Hosted signaling server on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
