import { useEffect, useRef, useState, useCallback } from "react";
import { socket } from "./socket";
import { logEntry } from "./utils";
import {
  generateKey, exportKeyToBase64, importKeyFromBase64,
  generateNonce, makeIV, nonceToBase64, base64ToNonce,
  encryptChunk, decryptChunk,
  encodeFrame, decodeFrame,
  hashBuffer,
} from "./crypto";
import { OPFSWriter, isOpfsAvailable, createDownloadUrl } from "./opfsWriter";
import ConnectionScreen from "./components/ConnectionScreen";
import TransferScreen   from "./components/TransferScreen";

// ─── Constants ────────────────────────────────────────────────────────────────
const STUN_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

const CHUNK_SIZE        = 64 * 1024;         // 64 KB plaintext
const BUFFER_THRESHOLD  = 4 * 1024 * 1024;  // 4 MB back-pressure threshold
const LARGE_FILE_LIMIT  = 50 * 1024 * 1024; // 50 MB → switch to OPFS

// ─── URL hash helpers ─────────────────────────────────────────────────────────
function getKeyFromHash() {
  const hash = window.location.hash; // e.g. "#key=abc123"
  const match = hash.match(/[#&]key=([^&]+)/);
  return match ? match[1] : null;
}

function setKeyInHash(b64Key) {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("room") || "";
  // Keep ?room= in search, put key in hash
  window.location.hash = `key=${b64Key}`;
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ──
  const [screen, setScreen]               = useState("connect");
  const [isConnecting, setIsConnecting]   = useState(false);
  const [roomId, setRoomId]               = useState(null);
  const [role, setRole]                   = useState(null);
  const [peerConnected, setPeerConnected] = useState(false);
  const [isEncrypted, setIsEncrypted]     = useState(false);
  const [logs, setLogs]                   = useState([]);
  const [selectedFile, setSelectedFile]   = useState(null);
  const [transferState, setTransferState] = useState({
    phase: "idle",     // idle|sending|receiving|resuming|done|error
    progress: 0,
    speed: 0,
    bytesDone: 0,
    totalBytes: 0,
    filename: null,
    filesize: 0,
    chunksDone: 0,
    totalChunks: 0,
    hashVerified: null,  // null | true | false
  });

  // ── Refs (WebRTC — no re-render needed) ──
  const pcRef          = useRef(null);
  const dcRef          = useRef(null);
  const downloadRef    = useRef(null);
  const cryptoKeyRef   = useRef(null);  // CryptoKey
  const keyReadyRef    = useRef(Promise.resolve()); // resolves when cryptoKeyRef is set
  const hasKeyOnLoadRef = useRef(false); // check if key was in URL on load
  const nonceRef       = useRef(null);  // Uint8Array[8], sender-generated
  const metaRef        = useRef(null);  // incoming file metadata
  const chunksRef      = useRef([]);    // in-memory chunk buffer (small files)
  const opfsRef        = useRef(null);  // OPFSWriter instance (large files)
  const useOpfsRef     = useRef(false);
  const lastRxChunkRef = useRef(-1);    // last received chunk index (for resume)
  const roleRef        = useRef(null);  // mirrors `role` state for closures
  const roomIdRef      = useRef(null);  // mirrors `roomId` state for closures

  // ── Speed meter ──
  const speedTimerRef  = useRef(null);
  const speedBytesRef  = useRef(0);
  const lastSpeedRef   = useRef(0);

  // ── Logging ──
  const addLog = useCallback((msg, type = "default") => {
    setLogs((prev) => [...prev.slice(-80), logEntry(msg, type)]);
  }, []);

  // ── Speed meter ──
  function startSpeedMeter() {
    speedBytesRef.current = 0;
    clearInterval(speedTimerRef.current);
    speedTimerRef.current = setInterval(() => {
      lastSpeedRef.current  = speedBytesRef.current;
      speedBytesRef.current = 0;
      setTransferState((p) => ({ ...p, speed: lastSpeedRef.current }));
    }, 1000);
  }
  function stopSpeedMeter() {
    clearInterval(speedTimerRef.current);
    setTransferState((p) => ({ ...p, speed: 0 }));
  }

  // ── On mount: check URL for room param + encryption key ──
  useEffect(() => {
    const params  = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    const keyB64  = getKeyFromHash();

    if (roomParam) {
      addLog(`Room ID in URL: ${roomParam.toUpperCase()}`, "info");
    }
    if (keyB64) {
      hasKeyOnLoadRef.current = true;
      setIsEncrypted(true);
      addLog("Encryption key found in URL — zero-knowledge mode active 🔒", "ok");
      // Store the promise so chunk handlers can await it before decrypting
      const keyPromise = importKeyFromBase64(keyB64)
        .then((k) => { cryptoKeyRef.current = k; })
        .catch(() => addLog("Failed to parse encryption key from URL", "err"));
      keyReadyRef.current = keyPromise;
    } else if (!roomParam) {
      // Pre-generate sender key & nonce so that the copied link has key immediately
      setIsEncrypted(true);
      const keyPromise = generateKey()
        .then(async (key) => {
          cryptoKeyRef.current = key;
          nonceRef.current     = generateNonce();
          const b64 = await exportKeyToBase64(key);
          setKeyInHash(b64);
        })
        .catch(() => addLog("Failed to pre-generate encryption key", "err"));
      keyReadyRef.current = keyPromise;
    }
  }, [addLog]);

  // ── Socket event wiring ──
  useEffect(() => {
    function onConnect()    { addLog("Connected to signaling server", "ok"); setIsConnecting(false); }
    function onDisconnect(r){ addLog(`Signaling disconnected: ${r}`, "err"); setIsConnecting(false); }

    function onPeerJoined() {
      addLog("Peer joined — starting WebRTC handshake", "ok");
      setPeerConnected(true);
      if (roleRef.current === "sender") initiateOffer();
    }

    function onPeerDisconnected() {
      addLog("Peer disconnected", "err");
      setPeerConnected(false);
      setTransferState((p) =>
        p.phase === "done" ? p : { ...p, phase: p.phase === "receiving" || p.phase === "sending" ? "resuming" : "error" }
      );
    }

    async function onOffer({ offer }) {
      addLog("Offer received from sender", "info");
      try {
        const pc = getPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", { roomId: roomIdRef.current, answer });
        addLog("Answer sent to sender", "info");
      } catch (err) {
        addLog(`Answer error: ${err.message}`, "err");
      }
    }

    async function onAnswer({ answer }) {
      addLog("Answer received from receiver", "info");
      try {
        await pcRef.current?.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        addLog(`Set remote answer error: ${err.message}`, "err");
      }
    }

    async function onIceCandidate({ candidate }) {
      try {
        await pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
      } catch { /* non-fatal */ }
    }

    socket.on("connect",           onConnect);
    socket.on("disconnect",        onDisconnect);
    socket.on("peer-joined",       onPeerJoined);
    socket.on("peer-disconnected", onPeerDisconnected);
    socket.on("offer",             onOffer);
    socket.on("answer",            onAnswer);
    socket.on("ice-candidate",     onIceCandidate);

    return () => {
      socket.off("connect",           onConnect);
      socket.off("disconnect",        onDisconnect);
      socket.off("peer-joined",       onPeerJoined);
      socket.off("peer-disconnected", onPeerDisconnected);
      socket.off("offer",             onOffer);
      socket.off("answer",            onAnswer);
      socket.off("ice-candidate",     onIceCandidate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── RTCPeerConnection factory ──
  function getPeerConnection() {
    if (pcRef.current) return pcRef.current;

    const pc     = new RTCPeerConnection(STUN_SERVERS);
    pcRef.current = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit("ice-candidate", { roomId: roomIdRef.current, candidate });
    };

    pc.oniceconnectionstatechange = () => {
      addLog(`ICE: ${pc.iceConnectionState}`, "info");
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        addLog("P2P connection established ✓", "ok");
      }
      if (pc.iceConnectionState === "failed") {
        addLog("ICE connection failed — STUN negotiation unsuccessful", "err");
      }
    };

    pc.onconnectionstatechange = () => {
      addLog(`Connection: ${pc.connectionState}`, "info");
    };

    // Receiver gets the data channel via this event
    pc.ondatachannel = ({ channel }) => {
      addLog(`Data channel received: ${channel.label}`, "info");
      setupReceiverChannel(channel);
    };

    return pc;
  }

  // ── Sender: create offer + data channel ──
  async function initiateOffer() {
    try {
      const pc = getPeerConnection();
      const dc = pc.createDataChannel("file-transfer", { ordered: true });
      dcRef.current = dc;
      setupSenderChannel(dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer", { roomId: roomIdRef.current, offer });
      addLog("Offer sent to receiver", "info");
    } catch (err) {
      addLog(`Offer error: ${err.message}`, "err");
    }
  }

  // ── Sender channel events ──
  function setupSenderChannel(dc) {
    dc.onopen  = () => { addLog("Data channel open — ready to send 🔒", "ok"); setPeerConnected(true); };
    dc.onclose = () => addLog("Data channel closed (sender)", "err");
    dc.onerror = (e) => addLog(`Data channel error: ${String(e)}`, "err");

    // Listen for control frames from receiver (resume-from, ack)
    dc.onmessage = ({ data }) => {
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "resume-from") {
            addLog(`Receiver requests resume from chunk ${msg.index}`, "info");
            // The sender loop reads this ref to restart
            resumeFromRef.current = msg.index;
          }
        } catch { /* ignore */ }
      }
    };
  }

  const resumeFromRef = useRef(null); // set by receiver's resume-from message

  // ── Receiver channel events ──
  function setupReceiverChannel(dc) {
    dc.binaryType = "arraybuffer";

    dc.onopen = () => {
      addLog("Data channel open — ready to receive 🔒", "ok");
      setPeerConnected(true);

      // If we have a last-received chunk from a previous session, request resume
      const last = lastRxChunkRef.current;
      if (last >= 0) {
        addLog(`Requesting resume from chunk ${last + 1}`, "info");
        dc.send(JSON.stringify({ type: "resume-from", index: last + 1 }));
        setTransferState((p) => ({ ...p, phase: "resuming" }));
      }
    };

    dc.onmessage = async ({ data }) => {
      // Text frame = metadata JSON or control message
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);

          if (msg.type === "transfer-start") {
            await handleTransferStart(msg, dc);
          }
        } catch {
          addLog("Unexpected text message from peer", "err");
        }
        return;
      }

      // Binary frame = encrypted chunk
      await handleIncomingChunk(data, dc);
    };

    dc.onclose = () => addLog("Data channel closed (receiver)", "info");
    dc.onerror = (e) => addLog(`Data channel error: ${String(e)}`, "err");
  }

  /** Called when the receiver gets the metadata frame. */
  async function handleTransferStart(meta, dc) {
    // Ensure the encryption key is fully imported before we start receiving chunks
    await keyReadyRef.current;

    metaRef.current = meta;
    lastRxChunkRef.current = -1;

    // Decide storage path
    const large = meta.size > LARGE_FILE_LIMIT && isOpfsAvailable();
    useOpfsRef.current  = large;
    chunksRef.current   = [];
    opfsRef.current     = null;

    if (large) {
      addLog(`Large file detected (${(meta.size / 1048576).toFixed(1)} MB) — using OPFS streaming`, "info");
      try {
        opfsRef.current = await OPFSWriter.open();
      } catch (err) {
        addLog(`OPFS unavailable: ${err.message} — falling back to in-memory`, "err");
        useOpfsRef.current = false;
      }
    }

    // Import nonce for IV derivation
    nonceRef.current = base64ToNonce(meta.nonce);

    addLog(`Incoming: ${meta.name} (${(meta.size / 1048576).toFixed(2)} MB, ${meta.totalChunks} chunks)`, "info");
    if (meta.sha256) addLog(`Expected SHA-256: ${meta.sha256.slice(0, 16)}…`, "info");

    setTransferState({
      phase: "receiving",
      progress: 0,
      speed: 0,
      bytesDone: 0,
      totalBytes: meta.size,
      filename: meta.name,
      filesize: meta.size,
      chunksDone: 0,
      totalChunks: meta.totalChunks,
      hashVerified: null,
    });
    startSpeedMeter();

    // Ack the metadata so sender knows we're ready (in case it was waiting)
    dc.send(JSON.stringify({ type: "ready" }));
  }

  /** Process one incoming binary frame. */
  async function handleIncomingChunk(buffer, dc) {
    const { chunkIndex, totalChunks, iv, payload } = decodeFrame(buffer);

    // Decrypt
    let decrypted;
    try {
      if (!cryptoKeyRef.current) {
        throw new Error("Missing encryption key. Please join using the full share link containing the key.");
      }
      decrypted = await decryptChunk(cryptoKeyRef.current, iv, payload);
    } catch (err) {
      if (err.message && err.message.includes("Missing encryption key")) {
        addLog(err.message, "err");
      } else {
        addLog(`Decryption failed on chunk ${chunkIndex} — wrong key or corrupted data`, "err");
      }
      setTransferState((p) => ({ ...p, phase: "error" }));
      return;
    }

    // Store chunk
    if (useOpfsRef.current && opfsRef.current) {
      await opfsRef.current.write(chunkIndex, decrypted);
    } else {
      chunksRef.current[chunkIndex] = decrypted; // sparse array is fine
    }

    lastRxChunkRef.current = chunkIndex;
    speedBytesRef.current += decrypted.byteLength;

    const chunksDone = chunkIndex + 1;
    const bytesDone  = Math.min(chunksDone * CHUNK_SIZE, metaRef.current?.size || 0);
    const progress   = Math.min(100, (bytesDone / (metaRef.current?.size || 1)) * 100);

    setTransferState((p) => ({
      ...p,
      bytesDone,
      progress,
      chunksDone,
      totalChunks,
    }));

    // All chunks received
    if (chunksDone >= totalChunks) {
      stopSpeedMeter();
      await assembleAndDownload(dc);
    }
  }

  /** Reassemble, verify SHA-256, trigger download. */
  async function assembleAndDownload(dc) {
    const meta = metaRef.current;
    if (!meta) return;

    addLog("Transfer complete — verifying integrity…", "info");

    let file;
    try {
      if (useOpfsRef.current && opfsRef.current) {
        file = await opfsRef.current.finalize(meta.name, meta.type || "application/octet-stream");
      } else {
        // Rebuild ordered blob from sparse array
        const ordered = [];
        for (let i = 0; i < chunksRef.current.length; i++) {
          if (chunksRef.current[i]) ordered.push(chunksRef.current[i]);
        }
        const blob = new Blob(ordered, { type: meta.type || "application/octet-stream" });
        file = new File([blob], meta.name, { type: meta.type || "application/octet-stream" });
      }

      // SHA-256 verification
      let hashVerified = null;
      if (meta.sha256) {
        const fileBuffer = await file.arrayBuffer();
        const actualHash = await hashBuffer(fileBuffer);
        hashVerified     = actualHash === meta.sha256;
        if (hashVerified) {
          addLog("SHA-256 verified ✓ — file integrity confirmed", "ok");
        } else {
          addLog(`SHA-256 mismatch ✕ — expected ${meta.sha256.slice(0, 16)}… got ${actualHash.slice(0, 16)}…`, "err");
        }
      }

      const url = createDownloadUrl(file);
      if (downloadRef.current) {
        downloadRef.current.href     = url;
        downloadRef.current.download = meta.name;
        downloadRef.current.click();
      }

      // Cleanup OPFS temp file after a delay
      if (useOpfsRef.current && opfsRef.current) {
        setTimeout(() => opfsRef.current?.cleanup(), 60_000);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      chunksRef.current = [];
      addLog(`Download started: ${meta.name}`, "ok");
      setTransferState((p) => ({ ...p, phase: "done", progress: 100, hashVerified }));

    } catch (err) {
      addLog(`Assembly error: ${err.message}`, "err");
      setTransferState((p) => ({ ...p, phase: "error" }));
    }
  }

  // ── Sender: send file ──
  async function handleSend(file) {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") {
      addLog("Data channel not ready", "err");
      return;
    }

    const key   = cryptoKeyRef.current;
    const nonce = nonceRef.current;

    if (!key || !nonce) {
      addLog("Encryption key not ready — cannot send", "err");
      return;
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Compute SHA-256 of the full file before sending
    addLog("Computing file hash…", "info");
    let sha256 = null;
    try {
      const fullBuf = await file.arrayBuffer();
      sha256        = await hashBuffer(fullBuf);
      addLog(`SHA-256: ${sha256.slice(0, 16)}…`, "info");
    } catch (err) {
      addLog(`Hash failed: ${err.message} — continuing without verification`, "err");
    }

    // Send metadata frame
    const meta = {
      type:        "transfer-start",
      name:         file.name,
      size:         file.size,
      mimeType:     file.type,
      totalChunks,
      nonce:        nonceToBase64(nonce),
      sha256,
    };
    dc.send(JSON.stringify(meta));

    addLog(`Sending: ${file.name} — ${totalChunks} chunks — encrypted 🔒`, "info");
    setTransferState({
      phase: "sending",
      progress: 0,
      speed: 0,
      bytesDone: 0,
      totalBytes: file.size,
      filename: file.name,
      filesize: file.size,
      chunksDone: 0,
      totalChunks,
      hashVerified: null,
    });
    startSpeedMeter();

    resumeFromRef.current = null;

    // ── Chunk send loop ──
    let startIndex = 0;

    // Small delay to let receiver set up before first chunk
    await new Promise((r) => setTimeout(r, 100));

    // If receiver requested a resume, start from that index
    if (resumeFromRef.current !== null) {
      startIndex = resumeFromRef.current;
      addLog(`Resuming from chunk ${startIndex}`, "info");
    }

    for (let i = startIndex; i < totalChunks; i++) {
      // Re-check if receiver sent a newer resume-from
      if (resumeFromRef.current !== null && resumeFromRef.current !== i) {
        i = resumeFromRef.current;
        resumeFromRef.current = null;
        addLog(`Re-syncing to chunk ${i}`, "info");
      }

      // Back-pressure: wait until buffer drains
      while (dc.bufferedAmount > BUFFER_THRESHOLD) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // Check channel is still alive
      if (dc.readyState !== "open") {
        addLog("Data channel closed mid-transfer — pausing", "err");
        setTransferState((p) => ({ ...p, phase: "resuming" }));
        return;
      }

      const start   = i * CHUNK_SIZE;
      const slice   = file.slice(start, start + CHUNK_SIZE);
      const plain   = await slice.arrayBuffer();
      const iv      = makeIV(nonce, i);
      const cipher  = await encryptChunk(key, iv, plain);
      const frame   = encodeFrame(i, totalChunks, iv, cipher);

      dc.send(frame);
      speedBytesRef.current += plain.byteLength;

      const bytesDone = Math.min((i + 1) * CHUNK_SIZE, file.size);
      const progress  = Math.min(100, (bytesDone / file.size) * 100);
      setTransferState((p) => ({
        ...p,
        bytesDone,
        progress,
        chunksDone: i + 1,
        totalChunks,
      }));
    }

    stopSpeedMeter();
    addLog("All chunks sent ✓", "ok");
    setTransferState((p) => ({ ...p, phase: "done", progress: 100 }));
  }

  // ── Join room ──
  function handleJoin(id) {
    setIsConnecting(true);
    setLogs([]);
    addLog(`Joining room ${id}…`, "info");

    if (!socket.connected) socket.connect();

    socket.emit("join-room", id, async (resp) => {
      if (resp?.error) {
        addLog(`Join failed: ${resp.error}`, "err");
        setIsConnecting(false);
        return;
      }

      const confirmedRole = resp.role;
      roomIdRef.current   = resp.roomId;
      roleRef.current     = confirmedRole;
      setRoomId(resp.roomId);
      setRole(confirmedRole);
      setScreen("transfer");
      setIsConnecting(false);
      addLog(`Joined room ${resp.roomId} as ${confirmedRole}`, "ok");

      if (confirmedRole === "sender") {
        // Update URL to include room ID so the address bar reflects the full share link
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set("room", resp.roomId);
        window.history.replaceState(null, "", currentUrl.toString());

        // Sender generates the encryption key + nonce if not already pre-generated
        if (!cryptoKeyRef.current) {
          const key   = await generateKey();
          const b64   = await exportKeyToBase64(key);
          const nonce = generateNonce();
          cryptoKeyRef.current = key;
          nonceRef.current     = nonce;
          keyReadyRef.current  = Promise.resolve();
          setIsEncrypted(true);
          setKeyInHash(b64);
        } else {
          // Key was pre-generated on mount — await it to be safe
          await keyReadyRef.current;
        }
        addLog("Encryption key generated and embedded in share URL 🔒", "ok");
      } else {
        // If we are a receiver and the original URL didn't have a key,
        // clear the pre-generated key!
        if (!hasKeyOnLoadRef.current) {
          cryptoKeyRef.current = null;
          setIsEncrypted(false);
          // Clear hash from URL
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }

        // Receiver: pre-create peer connection so it's ready for the offer
        getPeerConnection();
        setPeerConnected(true);
      }
    });
  }

  // ── Disconnect ──
  function handleDisconnect() {
    stopSpeedMeter();
    pcRef.current?.close();
    pcRef.current     = null;
    dcRef.current     = null;
    chunksRef.current = [];
    opfsRef.current   = null;
    cryptoKeyRef.current = null;
    nonceRef.current     = null;
    lastRxChunkRef.current = -1;
    resumeFromRef.current  = null;
    socket.disconnect();
    setScreen("connect");
    setRoomId(null);
    setRole(null);
    setPeerConnected(false);
    setIsEncrypted(false);
    setSelectedFile(null);
    setTransferState({
      phase: "idle", progress: 0, speed: 0,
      bytesDone: 0, totalBytes: 0,
      filename: null, filesize: 0,
      chunksDone: 0, totalChunks: 0,
      hashVerified: null,
    });
    setLogs([]);
    // Clear hash from URL
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  // ── Render ──
  return (
    <div className="app">
      <header className="app-header">
        <h1>p2p<span>.</span>share</h1>
        <p>direct browser-to-browser · zero-knowledge encrypted</p>
      </header>

      <main className="card" role="main">
        {screen === "connect" ? (
          <ConnectionScreen
            onJoin={handleJoin}
            isConnecting={isConnecting}
            isEncrypted={isEncrypted}
          />
        ) : (
          <TransferScreen
            role={role}
            roomId={roomId}
            peerConnected={peerConnected}
            isEncrypted={isEncrypted}
            transferState={transferState}
            logs={logs}
            onFileSelect={setSelectedFile}
            onSend={handleSend}
            onDisconnect={handleDisconnect}
            downloadRef={downloadRef}
          />
        )}
      </main>
    </div>
  );
}
