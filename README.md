# p2p.share

Initial -- Direct browser-to-browser file transfer, within same device.

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
# 1. Build the React bundle (outputs to server/dist/)
cd client && npm run build

# 2. Package for Linux (.deb + AppImage)
cd server && npm run package:linux

# 3. Package for Windows (NSIS installer) — run on Windows or with Wine
cd server && npm run package:win

# 4. Package for macOS (DMG) — must run on macOS
cd server && npm run package:mac

# 5. Build Linux + Windows in one command
cd server && npm run package:all
```

Output artifacts land in `server/release/`.

---
## Feature Set

### Core Transfer Engine
- **WebRTC Data Channel** — direct peer-to-peer transfer, no relay for data
- **64 KB chunked streaming** — constant memory footprint regardless of file size
- **AES-GCM-256 encryption** — every chunk independently encrypted
- **MD5 incremental integrity hashing** — rolling hash, verified on receipt
- **Back-pressure control** — sender waits when WebRTC buffer exceeds 4 MB
- **Out-of-order chunk buffering** — `DiskWriter` flushes only contiguous runs to disk

### Reliability & Recovery
- **Bitfield-based resume** — receiver tracks received chunks in a bitfield; resumes from gaps after reconnection
- **Automatic WebSocket relay fallback** — if P2P ICE fails or times out, the transfer falls back to a WebSocket relay through the signaling server
- **ICE failure promotion** — stalled `disconnected` state auto-promotes to relay after 20 seconds
- **Manual reconnect & pause/resume** — sender and receiver can pause mid-transfer and resume

### Storage
- *File System Access API** (`showSaveFilePicker`) — writes directly to the user's chosen location on disk, no browser sandbox limitation
- **OPFS fallback** — browsers without File System Access API write to the Origin Private File System then trigger a standard download

### Connectivity
- **SSH reverse tunnel** (`localhost.run`) — exposes the local signaling server as a public HTTPS URL
- **STUN servers** — Google STUN servers for NAT traversal

---
## Known Limitations

| Limitation | Notes |
|-----------|-------|
| **SSH tunnel dependency** | Requires internet access and `ssh` in `$PATH`. `localhost.run` is a free service with no uptime guarantee. |
| **Tunnel URL is dynamic** | The `lhr.life` URL changes every time the app restarts. |
| **Single active room** | The signaling server supports multiple concurrent rooms, but the Electron app UI manages one room at a time. |
| **Receiver needs a modern browser** | Requires WebRTC, File System Access API (Chrome 86+, Edge 86+; Firefox/Safari use OPFS fallback). |

---

### To be added
- in browser implementation
- full time standing server implementation (Render/Vercel or AWS)
