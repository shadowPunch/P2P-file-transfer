require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const crypto  = require("crypto");
const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors    = require("cors");
const helmet  = require("helmet");
const rateLimit = require("express-rate-limit");
const path    = require("path");

const PORT = process.env.PORT || 3001;

// ─── Structured logger ────────────────────────────────────────────────────────
// Outputs newline-delimited JSON to stdout. Pipe to any log drain for retention.
// Room IDs are never logged in plaintext — only an 8-char SHA-256 prefix.
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

// ─── ICE server config (read from env; falls back to public open relay) ───────
// To use a real TURN service set TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
// in .env (or OS env). No rebuild needed to rotate credentials.
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

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();

// Trust the Ngrok / SSH-tunnel reverse proxy so rate-limiting uses real IPs.
app.set("trust proxy", 1);

// Security headers — CSP is targeted, not disabled.
// The React bundle is served from the same origin so 'self' is sufficient.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'"],
      styleSrc:        ["'self'", "'unsafe-inline'"],   // CSS modules may use inline styles
      connectSrc:      ["'self'", "ws:", "wss:"],        // WebSocket to same origin
      imgSrc:          ["'self'", "data:"],
      objectSrc:       ["'none'"],
      frameAncestors:  ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Required for WebRTC SharedArrayBuffer usage
}));

// HTTP rate limiter — 100 req/min per IP on all HTTP routes.
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
}));

// CORS: allow the same-origin Electron window plus the active SSH tunnel URL.
// publicUrl is set by main.js once the tunnel is established.
let allowedOrigins = [`http://localhost:${PORT}`];
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no Origin header) and any registered origin
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
}));

app.use(express.json({ limit: "16kb" })); // Prevent JSON body bombs

// ─── Static files (compiled React bundle) ─────────────────────────────────────
const distPath = global.electronDistPath || path.join(__dirname, "dist");
log("info", "server.start", { distPath });
app.use(express.static(distPath));

// ─── HTTP endpoints ────────────────────────────────────────────────────────────
// Health check — returns server state without exposing room IDs.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: rooms.size, connections: io.engine.clientsCount });
});

// ICE config — returns TURN/STUN credentials from env, never from client bundle.
app.get("/api/ice-config", (_req, res) => {
  res.json(iceConfig);
});

// SPA fallback — must come after all API routes.
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// ─── HTTP server + Socket.io ───────────────────────────────────────────────────
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 96 * 1024, // Max WebSocket frame: 96 KB (64 KB chunk + overhead)
});

// ─── Room state ───────────────────────────────────────────────────────────────
// rooms: roomId → { sender: socketId|null, receiver: socketId|null, createdAt: ms }
const rooms = new Map();

// Sweep stale rooms every 5 minutes. Room TTL is 4 hours.
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

  // Enforce per-IP connection cap
  const connCount = (ipConnections.get(ip) || 0) + 1;
  if (connCount > MAX_CONNS_PER_IP) {
    log("warn", "ratelimit.conn_cap", { ip_hash: hashRoom(ip) });
    socket.disconnect(true);
    return;
  }
  ipConnections.set(ip, connCount);

  // ── Per-socket message rate limiter (50 msg/s) ──
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

  log("info", "socket.connected");

  // ── Membership guard — all relay events must check this ──
  const isMemberOf = (roomId) => socket.rooms.has(roomId);

  // ── join-room ──────────────────────────────────────────────────────────────
  socket.on("join-room", (payload, callback) => {
    let roomId      = typeof payload === "string" ? payload : payload?.id;
    let requestedRole = typeof payload === "object" ? payload?.role : undefined;

    // Validate room ID format
    const roomId_clean = String(roomId || "").trim().toUpperCase();
    if (!ROOM_ID_RE.test(roomId_clean)) {
      log("warn", "validation.roomid_reject", { reason: "bad format" });
      return callback?.({ error: "Invalid room ID" });
    }

    // Validate role
    if (requestedRole !== undefined && !VALID_ROLES.has(requestedRole)) {
      log("warn", "validation.role_reject", { reason: "invalid role" });
      return callback?.({ error: "Invalid role" });
    }

    const room = rooms.get(roomId_clean) || { sender: null, receiver: null, createdAt: Date.now() };

    if (requestedRole) {
      if (room[requestedRole]) {
        return callback?.({ error: `Role '${requestedRole}' is already taken in this room` });
      }
    } else {
      // Auto-assign role
      if      (!room.sender   && !room.receiver) requestedRole = "sender";
      else if (!room.receiver)                   requestedRole = "receiver";
      else if (!room.sender)                     requestedRole = "sender";
      else return callback?.({ error: "Room is full (max 2 peers)" });
    }

    // Leave any previous rooms
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
  // Each handler: rate-limit → membership check → size cap → relay.

  socket.on("offer", (payload) => {
    if (isRateLimited()) return;
    const { roomId, offer } = payload || {};
    if (!roomId || !offer || !isMemberOf(roomId)) return;
    if (JSON.stringify(offer).length > 8192) return; // SDP size cap
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

  // relay-data: binary file chunks. Rate-limited by bytes/second, not message count,
  // to allow high-throughput transfers while still preventing bandwidth abuse.
  const MAX_RELAY_FRAME_BYTES = 96 * 1024;      // must match maxHttpBufferSize
  const MAX_RELAY_BYTES_PER_SEC = 20 * 1024 * 1024; // 20 MB/s per socket

  socket.on("relay-data", (payload) => {
    const { roomId, data } = payload || {};
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

// ─── Exports ──────────────────────────────────────────────────────────────────
// Expose allowedOrigins so main.js can register the tunnel URL after startup.
const serverReady = new Promise((resolve) => {
  httpServer.listen(PORT, () => {
    log("info", "server.listening", { port: PORT });
    console.log(`\n🚀 Signaling server on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health\n`);
    resolve(PORT);
  });
});

module.exports = { serverReady, allowedOrigins };
