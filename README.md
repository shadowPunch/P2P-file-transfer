# p2p.share — Phase 1–3

Direct browser-to-browser file transfer, within same device.

UPDATE 1 -- implemented ngrok tunnelling to allow for interdevice, inter network transfer. However, doesnt work if the network firewall blocks p2p.

UPDATE 2 -- large file transfer enabled with direct to disk writing using OPFS, and routed it to downloads folder. Added pausability and auto reconnection. Also improved UI and removed misleading keys.

UPDATE 3 -- fallback with websocket relays to get around firewalls restricting p2p.

UPDATE 4 -- packaged application using electron. Replaced ngrok with localhost.run for tunnelling (SSH tunneling) to avoi auth key registration. Packaged application for linux, windows, macOs.  

## Project Structure

```
p2p-share-phase1-3/
│
├── client/                   # React frontend (Vite)
│   ├── src/
│   │   ├── App.jsx           # Main app component — state machine, WebRTC, transfer logic
│   │   ├── components/
│   │   │   ├── ConnectionScreen.jsx   # Role selection + room join UI
│   │   │   └── TransferScreen.jsx    # Transfer progress, file picker, log console
│   │   ├── crypto.js         # AES-GCM-256, IV derivation, frame encode/decode, MD5 hash
│   │   ├── diskWriter.js     # Direct-to-disk streaming writer (File System Access + OPFS)
│   │   ├── socket.js         # Socket.IO client (relative URL, autoConnect: false)
│   │   └── utils.js          # Room ID (CSPRNG), formatters, clipboard helper
│   └── vite.config.js        # Outputs to ../server/dist for unified serving
│
├── server/                   # Express signaling server + Electron main process
│   ├── main.js               # Electron main: distPath resolution, Chromium flags, IPC
│   ├── preload.js            # Context bridge: getPublicUrl, onTunnelUrl, copyToClipboard
│   ├── server.js             # Express + Socket.IO: static serving, room management, relay
│   ├── dist/                 # Built React bundle (output of `vite build`)
│   ├── package.json          # electron-builder config, multi-platform targets
│   └── .env                  # Local config (PORT — gitignored, never committed)
│
└── README.md
```
---

## Building & Running

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9
- Linux: `fpm` for `.deb` packaging (installed by electron-builder automatically)
- Windows: Run natively or in a Windows CI environment
- macOS: Must be built on macOS for code signing

### Development

```bash
# Install root dependencies
npm install

# Start signaling server + Vite dev server
npm run dev

# Or separately:
npm run server   # Express on localhost:3001
npm run client   # Vite on localhost:5173 (proxies /socket.io → 3001)
```

### Electron (development)

```bash
cd server
npm install
npm run start:electron
```

### Production Build

```bash
# With server running on :3001
node test-server.js
```

## Feature Set

### Core Transfer Engine
- ✅ **WebRTC Data Channel** — direct peer-to-peer transfer, no relay for data
- ✅ **64 KB chunked streaming** — constant memory footprint regardless of file size
- ✅ **AES-GCM-256 encryption** — every chunk independently encrypted
- ✅ **Per-chunk IV derivation** — `nonce[8] || chunkIndex[4]` (deterministic, no IV reuse)
- ✅ **MD5 incremental integrity hashing** — rolling hash, verified on receipt
- ✅ **Back-pressure control** — sender waits when WebRTC buffer exceeds 4 MB
- ✅ **Out-of-order chunk buffering** — `DiskWriter` flushes only contiguous runs to disk

### Reliability & Recovery
- ✅ **Bitfield-based resume** — receiver tracks received chunks in a bitfield; resumes from gaps after reconnection
- ✅ **Automatic WebSocket relay fallback** — if P2P ICE fails or times out, the transfer falls back to a WebSocket relay through the signaling server
- ✅ **ICE failure promotion** — stalled `disconnected` state auto-promotes to relay after 20 seconds
- ✅ **Manual reconnect & pause/resume** — sender and receiver can pause mid-transfer and resume

### Storage
- ✅ **File System Access API** (`showSaveFilePicker`) — writes directly to the user's chosen location on disk, no browser sandbox limitation
- ✅ **OPFS fallback** — browsers without File System Access API write to the Origin Private File System then trigger a standard download

### Connectivity
- ✅ **SSH reverse tunnel** (`localhost.run`) — exposes the local signaling server as a public HTTPS URL
- ✅ **STUN servers** — Google STUN servers for NAT traversal
- ✅ **TURN servers** (`openrelay.metered.ca`) — relayed ICE path for symmetric NATs
- ✅ **Tunnel-ready push** — Electron main process pushes the public URL to the renderer via `webContents.send` the instant SSH tunnel establishes (no polling)
- ✅ **Copy-link guard** — "copy link" button is disabled until the tunnel is ready, preventing accidental localhost URL copying

### Electron / Desktop
- ✅ **Self-contained executable** — packaged with `electron-builder`; ships its own Node.js runtime, no user installation of Node required
- ✅ **Linux AppArmor compatibility** — `--no-sandbox`, `--disable-dev-shm-usage`, `--no-zygote` flags prevent Compositor crashes under restrictive AppArmor profiles applied by `.deb` packages
- ✅ **ASAR-safe static serving** — React bundle is unpacked outside the ASAR archive (`asarUnpack`) so `express.static` can serve it using native `fs` calls
- ✅ **Server-ready gate** — `main.js` awaits the Express `listen` callback before creating the `BrowserWindow`, eliminating the race condition blank-screen bug
- ✅ **Key fragment filtered from logs** — renderer console messages containing `key=` are suppressed before forwarding to `journalctl`

---

### To be added
- in browser implementation
- full time standing server implementation (Render/Vercel or AWS)
