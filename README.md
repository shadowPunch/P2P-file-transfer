# p2p.share — Phase 1–3

Direct browser-to-browser file transfer, within same device.

UPDATE 1 -- implemented ngrok tunnelling to allow for interdevice, inter network transfer. However, doesnt work if the network firewall blocks p2p.

UPDATE 2 -- large file transfer enabled with direct to disk writing using OPFS, and routed it to downloads folder. Added pausability and auto reconnection. Also improved UI and removed misleading keys.

## Project structure

```
p2p-share/
├── server/          ← Node.js signaling server
│   ├── server.js
│   └── package.json
├── client/          ← React + Vite frontend
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx          ← socket events, WebRTC engine, state
│   │   ├── socket.js        ← singleton socket.io-client
│   │   ├── utils.js         ← helpers
│   │   ├── index.css        ← full design system
│   │   └── components/
│   │       ├── ConnectionScreen.jsx
│   │       └── TransferScreen.jsx
│   └── vite.config.js       ← dev proxy → :3001
├── test-server.js   ← signaling server integration tests
└── package.json     ← root scripts
```

## Running locally

```bash
# Terminal 1 — signaling server
cd server && npm install && node server.js

# Terminal 2 — React dev server
cd client && npm install && npm run dev
```

Open http://localhost:5173 in two browser tabs.

## Running tests

```bash
# With server running on :3001
node test-server.js
```

## What's implemented (Phase 1–3)

- ✅ Express + Socket.io signaling server
- ✅ Room management (2-peer max, role assignment)
- ✅ Offer / answer / ICE relay
- ✅ Graceful disconnect handling
- ✅ FileReader chunking with bufferedAmount back-pressure
- ✅ Blob reassembly + auto-download trigger
- ✅ Real-time progress
- ngrok for tunnelling
- AES-GCM encryption (Web Crypto API, key in URL hash)
- Per-chunk SHA-256 verification
- OPFS / streaming writes for large files (>500 MB)
- Connection churn recovery with chunk index resume

## What comes next (Phase 4–5)

- AWS for standing full time deployment
- transfer through firewalls using fallback
- deployment containerization
- mesh network for multi recipient

