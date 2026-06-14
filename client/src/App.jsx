import { useEffect, useRef, useState, useCallback } from "react";
import { socket } from "./socket";
import { logEntry } from "./utils";
import {
  generateKey, exportKeyToBase64, importKeyFromBase64,
  generateNonce, makeIV, nonceToBase64, base64ToNonce,
  encryptChunk, decryptChunk,
  encodeFrame, decodeFrame,
  hashFileIncremental
} from "./crypto";
import { DiskWriter } from "./diskWriter";
import ConnectionScreen from "./components/ConnectionScreen";
import TransferScreen   from "./components/TransferScreen";

// ─── Constants ────────────────────────────────────────────────────────────────
const STUN_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // Free TURN servers so cross-NAT connections work when one peer is on
    // a remote network (e.g. receiver opening the SSH tunnel URL).
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

const CHUNK_SIZE        = 64 * 1024;         // 64 KB plaintext
const BUFFER_THRESHOLD  = 4 * 1024 * 1024;  // 4 MB back-pressure threshold

// ─── URL hash helpers ─────────────────────────────────────────────────────────
function getKeyFromHash() {
  const hash = window.location.hash;
  const match = hash.match(/[#&]key=([^&]+)/);
  return match ? match[1] : null;
}

function setKeyInHash(b64Key) {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("room") || "";
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
  const [tunnelUrl, setTunnelUrl]           = useState(null);
  const [transferState, setTransferState] = useState({
    phase: "idle",     // idle | pending-accept | sending | receiving | interrupted | paused | done | error
    progress: 0,
    speed: 0,
    bytesDone: 0,
    totalBytes: 0,
    filename: null,
    filesize: 0,
    chunksDone: 0,
    totalChunks: 0,
    hashVerified: null,
  });

  // ── Refs ──
  const pcRef          = useRef(null);
  const dcRef          = useRef(null);
  const cryptoKeyRef   = useRef(null);
  const keyReadyRef    = useRef(Promise.resolve());
  const hasKeyOnLoadRef = useRef(false);
  const nonceRef       = useRef(null);
  const metaRef        = useRef(null);
  
  const diskWriterRef  = useRef(null);
  const roleRef        = useRef(null);
  const roomIdRef      = useRef(null);
  const selectedFileRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const useRelayRef    = useRef(false); 
  
  // Sender specific refs for resumability
  const bitfieldRef    = useRef(null);
  const isPausedRef    = useRef(false);
  const transferLoopRunningRef = useRef(false);

  // ── Speed meter ──
  const speedTimerRef  = useRef(null);
  const speedBytesRef  = useRef(0);
  const lastSpeedRef   = useRef(0);

  // ── Logging ──
  const addLog = useCallback((msg, type = "default") => {
    setLogs((prev) => [...prev.slice(-80), logEntry(msg, type)]);
  }, []);

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

  // ── On mount ──
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
      const keyPromise = importKeyFromBase64(keyB64)
        .then((k) => { cryptoKeyRef.current = k; })
        .catch(() => addLog("Failed to parse encryption key from URL", "err"));
      keyReadyRef.current = keyPromise;
    } else if (!roomParam) {
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

  // ── Electron Public URL integration ─────────────────────────────────────────────
  useEffect(() => {
    if (!window.electronAPI) return;

    // Register push listener FIRST so we don't miss the event.
    // main.js calls win.webContents.send('tunnel-url', url) the instant
    // the SSH tunnel establishes — no polling needed.
    if (window.electronAPI.onTunnelUrl) {
      window.electronAPI.onTunnelUrl((url) => {
        addLog(`🌐 Public tunnel ready: ${url}`, "ok");
        setTunnelUrl(url);
      });
    }

    // One-shot check: if the tunnel was already up before this component
    // mounted (e.g. the window loaded after the tunnel was established).
    window.electronAPI.getPublicUrl?.().then((url) => {
      if (url) {
        addLog(`🌐 Tunnel already active: ${url}`, "ok");
        setTunnelUrl(url);
      } else {
        addLog("SSH tunnel connecting… share link will update when ready.", "info");
      }
    });
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
        p.phase === "done" ? p : { ...p, phase: "interrupted" }
      );
    }

    async function onOffer({ offer }) {
      addLog("Offer received from sender", "info");
      try {
        const pc = getPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        for (const candidate of pendingCandidatesRef.current) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
        pendingCandidatesRef.current = [];

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
        const pc = pcRef.current;
        await pc?.setRemoteDescription(new RTCSessionDescription(answer));

        for (const candidate of pendingCandidatesRef.current) {
          await pc?.addIceCandidate(candidate).catch(() => {});
        }
        pendingCandidatesRef.current = [];
      } catch (err) {
        addLog(`Set remote answer error: ${err.message}`, "err");
      }
    }

    async function onIceCandidate({ candidate }) {
      try {
        const pc = pcRef.current;
        if (!pc || !pc.remoteDescription) {
          pendingCandidatesRef.current.push(new RTCIceCandidate(candidate));
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch { /* non-fatal */ }
    }

    function onReconnectSignal() {
      addLog("Reconnect signal received, restarting WebRTC handshake", "info");
      if (roleRef.current === "sender") initiateOffer();
    }

    function onFallbackRelay() {
      addLog("⚠️ Peer requested WebSocket Relay fallback. Switching to Relay Mode.", "warn");
      useRelayRef.current = true;
      if (roleRef.current === "sender") {
        // We act like the data channel is open
        isPausedRef.current = false;
        if (!transferLoopRunningRef.current && selectedFileRef.current) {
          handleSend(selectedFileRef.current, true);
        }
      }
    }

    async function onRelayData(data) {
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "ready") {
            addLog("Receiver accepted file (Relay Mode). Starting transmission...", "ok");
            isPausedRef.current = false;
            if (!transferLoopRunningRef.current && selectedFileRef.current) {
               handleSend(selectedFileRef.current, true);
            }
          } else if (msg.type === "resume") {
            addLog(`Receiver requests resume with bitfield map (Relay Mode)`, "info");
            bitfieldRef.current = new Uint8Array(msg.bitfield);
            isPausedRef.current = false;
            setTransferState(p => ({...p, phase: "sending"}));
            if (!transferLoopRunningRef.current && selectedFileRef.current) {
               handleSend(selectedFileRef.current, true);
            }
          } else if (msg.type === "pause") {
            addLog("Peer paused the transfer", "info");
            isPausedRef.current = true;
            setTransferState(p => ({...p, phase: "paused"}));
          } else if (msg.type === "transfer-start") {
            metaRef.current = msg;
            nonceRef.current = base64ToNonce(msg.nonce);
            addLog(`Incoming via Relay: ${msg.name} (${(msg.size / 1048576).toFixed(2)} MB)`, "info");
            setTransferState({
              phase: "pending-accept", progress: 0, speed: 0, bytesDone: 0,
              totalBytes: msg.size, filename: msg.name, filesize: msg.size,
              chunksDone: 0, totalChunks: msg.totalChunks, hashVerified: null,
            });
          }
        } catch {}
      } else {
        await handleIncomingChunk(data);
      }
    }

    socket.on("connect",           onConnect);
    socket.on("disconnect",        onDisconnect);
    socket.on("peer-joined",       onPeerJoined);
    socket.on("peer-disconnected", onPeerDisconnected);
    socket.on("offer",             onOffer);
    socket.on("answer",            onAnswer);
    socket.on("ice-candidate",     onIceCandidate);
    socket.on("reconnect-signal",  onReconnectSignal);
    socket.on("fallback-relay",    onFallbackRelay);
    socket.on("relay-data",        onRelayData);

    return () => {
      socket.off("connect",           onConnect);
      socket.off("disconnect",        onDisconnect);
      socket.off("peer-joined",       onPeerJoined);
      socket.off("peer-disconnected", onPeerDisconnected);
      socket.off("offer",             onOffer);
      socket.off("answer",            onAnswer);
      socket.off("ice-candidate",     onIceCandidate);
      socket.off("reconnect-signal",  onReconnectSignal);
      socket.off("fallback-relay",    onFallbackRelay);
      socket.off("relay-data",        onRelayData);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendData(data) {
    if (useRelayRef.current) {
      socket.emit("relay-data", { roomId: roomIdRef.current, data });
    } else if (dcRef.current?.readyState === "open") {
      dcRef.current.send(data);
    }
  }

  // ── RTCPeerConnection factory ──
  function getPeerConnection() {
    if (pcRef.current) return pcRef.current;

    const pc     = new RTCPeerConnection(STUN_SERVERS);
    pcRef.current = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        if (candidate.candidate.includes('srflx')) {
          addLog("DIAGNOSTIC: Discovered Public IP (STUN Success)", "ok");
        }
        socket.emit("ice-candidate", { roomId: roomIdRef.current, candidate });
      }
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        addLog("DIAGNOSTIC: ICE gathering complete", "info");
      }
    };

    pc.oniceconnectionstatechange = async () => {
      addLog(`ICE: ${pc.iceConnectionState}`, "info");
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        addLog("P2P connection established ✓", "ok");
      }
      if (pc.iceConnectionState === "disconnected") {
        setTransferState(p => p.phase === "done" ? p : { ...p, phase: "interrupted" });
        // Give ICE 20 seconds to recover from a transient disconnection before
        // auto-promoting to relay fallback. This handles the case where ICE
        // stalls at 'disconnected' (common when one peer is on a remote network
        // via the SSH tunnel) rather than advancing to 'failed'.
        setTimeout(() => {
          if (pcRef.current?.iceConnectionState === "disconnected" ||
              pcRef.current?.iceConnectionState === "failed") {
            addLog("ICE stalled — auto-switching to WebSocket Relay Mode.", "err");
            handleManualReconnect(true);
          }
        }, 20_000);
      }
      if (pc.iceConnectionState === "failed") {
        addLog("ICE failed — automatically falling back to Relay Mode.", "err");
        handleManualReconnect(true);
      }
    };

    pc.onconnectionstatechange = () => {
      addLog(`Connection: ${pc.connectionState}`, "info");
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        if (pc.connectionState === "failed") {
          handleManualReconnect(true);
        } else {
          setTransferState(p => p.phase === "done" ? p : { ...p, phase: "interrupted" });
        }
      }
    };

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
    dc.onopen  = () => { 
      addLog("Data channel open — ready to send 🔒", "ok"); 
      setPeerConnected(true); 
    };
    dc.onclose = () => {
      addLog("Data channel closed", "err");
      setTransferState(p => p.phase === "done" ? p : { ...p, phase: "interrupted" });
    };
    dc.onerror = (e) => addLog(`Data channel error`, "err");

    dc.onmessage = ({ data }) => {
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "ready") {
            addLog("Receiver accepted file. Starting transmission...", "ok");
            isPausedRef.current = false;
            if (!transferLoopRunningRef.current && selectedFileRef.current) {
               // Only trigger handleSend if we aren't already looping
               // Pass true so it skips the metadata phase and starts the chunk loop!
               handleSend(selectedFileRef.current, true);
            }
          } else if (msg.type === "resume") {
            addLog(`Receiver requests resume with bitfield map`, "info");
            bitfieldRef.current = new Uint8Array(msg.bitfield);
            isPausedRef.current = false;
            setTransferState(p => ({...p, phase: "sending"}));
            if (!transferLoopRunningRef.current && selectedFileRef.current) {
               handleSend(selectedFileRef.current, true);
            }
          } else if (msg.type === "pause") {
            addLog("Receiver paused the transfer", "info");
            isPausedRef.current = true;
            setTransferState(p => ({...p, phase: "paused"}));
          }
        } catch { /* ignore */ }
      }
    };
  }

  // ── Receiver channel events ──
  function setupReceiverChannel(dc) {
    dcRef.current = dc;
    dc.binaryType = "arraybuffer";

    dc.onopen = () => {
      addLog("Data channel open — ready to receive 🔒", "ok");
      setPeerConnected(true);

      // If we have an existing disk writer, we are resuming an interrupted/paused transfer!
      if (diskWriterRef.current && metaRef.current) {
        addLog(`Sending Bitfield Map to resume transfer`, "info");
        setTransferState(p => ({ ...p, phase: "receiving" }));
        sendData(JSON.stringify({ 
          type: "resume", 
          bitfield: diskWriterRef.current.getBitfieldArray() 
        }));
      }
    };

    dc.onmessage = async ({ data }) => {
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "transfer-start") {
            // Receiver got metadata. Prompt them to Accept.
            metaRef.current = msg;
            nonceRef.current = base64ToNonce(msg.nonce);
            addLog(`Incoming: ${msg.name} (${(msg.size / 1048576).toFixed(2)} MB)`, "info");
            if (msg.sha256) addLog(`Expected SHA-256: ${msg.sha256.slice(0, 16)}…`, "info");

            setTransferState({
              phase: "pending-accept",
              progress: 0,
              speed: 0,
              bytesDone: 0,
              totalBytes: msg.size,
              filename: msg.name,
              filesize: msg.size,
              chunksDone: 0,
              totalChunks: msg.totalChunks,
              hashVerified: null,
            });
          } else if (msg.type === "pause") {
            addLog("Sender paused the transfer", "info");
            setTransferState(p => ({...p, phase: "paused"}));
          } else if (msg.type === "resume") {
            addLog("Sender resumed the transfer", "info");
            setTransferState(p => ({...p, phase: "receiving"}));
          }
        } catch {
          addLog("Unexpected text message from peer", "err");
        }
        return;
      }

      await handleIncomingChunk(data);
    };

    dc.onclose = () => {
      addLog("Data channel closed", "info");
      setTransferState(p => p.phase === "done" ? p : { ...p, phase: "interrupted" });
    };
    dc.onerror = (e) => addLog(`Data channel error`, "err");
  }

  // ── Receiver: Accept File ──
  async function handleAcceptFile() {
    const meta = metaRef.current;
    if (!meta) return;

    try {
      addLog("Prompting for save location...", "info");
      // Open disk writer (prompts user)
      diskWriterRef.current = await DiskWriter.open(meta.name, meta.totalChunks);
      
      setTransferState(p => ({...p, phase: "receiving"}));
      startSpeedMeter();

      // Tell sender we are ready
      sendData(JSON.stringify({ type: "ready" }));
    } catch (e) {
      if (e.name === 'AbortError') {
        addLog("Save cancelled by user", "err");
        setTransferState(p => ({...p, phase: "idle"}));
      } else {
        addLog(`File system error: ${e.message}`, "err");
      }
    }
  }

  /** Process one incoming binary frame. */
  async function handleIncomingChunk(buffer) {
    const { chunkIndex, totalChunks, iv, payload } = decodeFrame(buffer);

    let decrypted;
    try {
      if (!cryptoKeyRef.current) throw new Error("Missing encryption key.");
      decrypted = await decryptChunk(cryptoKeyRef.current, iv, payload);
    } catch (err) {
      addLog(`Decryption failed on chunk ${chunkIndex}`, "err");
      setTransferState(p => ({ ...p, phase: "error" }));
      return;
    }

    if (diskWriterRef.current) {
      await diskWriterRef.current.write(chunkIndex, decrypted);
    }

    speedBytesRef.current += decrypted.byteLength;
    const chunksDone = (diskWriterRef.current?.bytesWritten || 0) / CHUNK_SIZE; 
    const bytesDone  = diskWriterRef.current?.bytesWritten || 0;
    const progress   = Math.min(100, (bytesDone / (metaRef.current?.size || 1)) * 100);

    setTransferState(p => ({
      ...p, bytesDone, progress, chunksDone: Math.floor(chunksDone), totalChunks
    }));

    // If file is completely written
    if (bytesDone >= (metaRef.current?.size || 0)) {
      stopSpeedMeter();
      await finishFileAndVerify();
    }
  }

  /** Reassemble, verify MD5, trigger download if necessary. */
  async function finishFileAndVerify() {
    const meta = metaRef.current;
    if (!meta || !diskWriterRef.current) return;

    addLog("Transfer complete — verifying integrity…", "info");

    try {
      const { file, hash, handle } = await diskWriterRef.current.finalize(meta.name, meta.type);
      
      let hashVerified = null;
      if (meta.sha256) {
        hashVerified = (hash === meta.sha256);
        if (hashVerified) {
          addLog("Rolling Hash verified ✓ — file integrity confirmed", "ok");
        } else {
          addLog(`Hash mismatch ✕ — expected ${meta.sha256.slice(0, 16)}… got ${hash.slice(0, 16)}…`, "err");
        }
      }

      // If it fell back to OPFS, trigger a standard download anchor
      if (!window.showSaveFilePicker && file) {
         addLog("Downloading from browser sandbox to your computer...", "info");
         const url = URL.createObjectURL(file);
         const a = document.createElement("a");
         a.href = url;
         a.download = meta.name;
         a.click();
         setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
         addLog("File saved directly to disk! ✓", "ok");
      }

      setTransferState(p => ({ ...p, phase: "done", progress: 100, hashVerified }));
    } catch (err) {
      addLog(`Assembly error: ${err.message}`, "err");
      setTransferState(p => ({ ...p, phase: "error" }));
    }
  }

  // ── Sender: send file ──
  async function handleSend(file, isResuming = false) {
    if (transferLoopRunningRef.current) return;
    
    if (!useRelayRef.current && (!dcRef.current || dcRef.current.readyState !== "open")) {
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

    if (!isResuming) {
      // Compute Incremental MD5 of the full file before sending
      addLog("Computing file hash…", "info");
      let sha256 = null; // using MD5 but keeping variable name for compatibility
      try {
        sha256 = await hashFileIncremental(file, (pct) => {
           // could update UI here, but it's fast
        });
        addLog(`MD5: ${sha256.slice(0, 16)}…`, "info");
      } catch (err) {
        addLog(`Hash failed: ${err.message}`, "err");
      }

      const meta = {
        type:        "transfer-start",
        name:         file.name,
        size:         file.size,
        mimeType:     file.type,
        totalChunks,
        nonce:        nonceToBase64(nonce),
        sha256,
      };
      sendData(JSON.stringify(meta));
      addLog(`Metadata sent. Waiting for receiver to accept…`, "info");
      
      setTransferState({
        phase: "pending-accept",
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
      return; // Exit here. The 'ready' message from receiver will trigger handleSend again.
    }

    // --- Transmission Loop ---
    transferLoopRunningRef.current = true;
    startSpeedMeter();
    setTransferState(p => ({ ...p, phase: "sending" }));

    let chunksSentThisSession = 0;

    for (let i = 0; i < totalChunks; i++) {
      // 1. Check if paused
      while (isPausedRef.current) {
        await new Promise((r) => setTimeout(r, 100));
        // If channel closed while paused, abort loop
        if (dcRef.current?.readyState !== "open") break;
      }

      // 2. Check channel alive
      if (!useRelayRef.current && dcRef.current?.readyState !== "open") {
        addLog("Data channel interrupted mid-transfer", "err");
        setTransferState(p => p.phase === "done" ? p : { ...p, phase: "interrupted" });
        transferLoopRunningRef.current = false;
        return;
      }

      // 3. Bitfield check (skip chunks the receiver already has)
      if (bitfieldRef.current) {
        const byteIdx = Math.floor(i / 8);
        const bitIdx = i % 8;
        if ((bitfieldRef.current[byteIdx] & (1 << bitIdx)) !== 0) {
           // Skip this chunk
           continue;
        }
      }

      // 4. Back-pressure (WebRTC only)
      if (!useRelayRef.current && dcRef.current) {
        while (dcRef.current.bufferedAmount > BUFFER_THRESHOLD) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }

      const start   = i * CHUNK_SIZE;
      const slice   = file.slice(start, start + CHUNK_SIZE);
      const plain   = await slice.arrayBuffer();
      const iv      = makeIV(nonce, i);
      const cipher  = await encryptChunk(key, iv, plain);
      const frame   = encodeFrame(i, totalChunks, iv, cipher);

      sendData(frame);
      speedBytesRef.current += plain.byteLength;
      chunksSentThisSession++;

      const bytesDone = Math.min((i + 1) * CHUNK_SIZE, file.size);
      const progress  = Math.min(100, (bytesDone / file.size) * 100);
      setTransferState(p => ({
        ...p, bytesDone, progress, chunksDone: i + 1, totalChunks,
      }));
    }

    stopSpeedMeter();
    transferLoopRunningRef.current = false;
    
    // Only set to done if we actually sent everything.
    if (useRelayRef.current || dcRef.current?.readyState === "open") {
      addLog("All chunks sent ✓", "ok");
      setTransferState(p => ({ ...p, phase: "done", progress: 100 }));
    }
  }

  // ── Manual Control Functions ──
  function togglePause() {
    const isNowPaused = !isPausedRef.current;
    isPausedRef.current = isNowPaused;
    setTransferState(p => ({ ...p, phase: isNowPaused ? "paused" : (roleRef.current === "sender" ? "sending" : "receiving") }));
    
    // Inform peer
    sendData(JSON.stringify({ type: isNowPaused ? "pause" : "resume" }));
  }

  function handleManualReconnect(useRelay = false) {
    if (useRelay) {
      addLog("⚠️ Switching to WebSocket Relay Mode...", "warn");
      useRelayRef.current = true;
      socket.emit("fallback-relay", { roomId: roomIdRef.current });
      
      // If we are resuming, we should send the bitfield!
      if (roleRef.current === "receiver" && diskWriterRef.current && metaRef.current) {
        addLog(`Sending Bitfield Map to resume transfer (Relay)`, "info");
        setTransferState(p => ({ ...p, phase: "receiving" }));
        sendData(JSON.stringify({ 
          type: "resume", 
          bitfield: diskWriterRef.current.getBitfieldArray() 
        }));
      } else {
        setTransferState(p => ({...p, phase: "resuming"}));
      }
      return;
    }

    addLog("Attempting manual reconnect (P2P)...", "info");
    setTransferState(p => ({...p, phase: "resuming"}));
    
    // Kill old PC
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    
    // Tell the signaling server to ping the other peer to restart WebRTC
    socket.emit("reconnect-signal", { roomId: roomIdRef.current });
    
    // Sender will receive this and call initiateOffer()
    // Receiver will just recreate the peer connection
    if (roleRef.current === "receiver") {
      getPeerConnection();
    }
  }

  // ── Join room ──
  function handleJoin(id, requestedRole) {
    setIsConnecting(true);
    setLogs([]);
    addLog(`Joining room ${id}…`, "info");

    if (!socket.connected) socket.connect();

    socket.emit("join-room", { id, role: requestedRole }, async (resp) => {
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

      // Update URL to include room ID so the address bar reflects the full share link
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set("room", resp.roomId);
      window.history.replaceState(null, "", currentUrl.toString());

      // If we don't have a key from the URL, we are the creator of this room,
      // so we must generate the key and nonce.
      if (!hasKeyOnLoadRef.current) {
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
      }

      // Pre-create peer connection
      getPeerConnection();
      
      if (resp.peerCount === 2) {
        setPeerConnected(true);
        if (confirmedRole === "sender") {
           initiateOffer();
        }
      }
    });
  }

  // ── Disconnect ──
  function handleDisconnect() {
    stopSpeedMeter();
    pcRef.current?.close();
    pcRef.current     = null;
    dcRef.current     = null;
    if (diskWriterRef.current) diskWriterRef.current.cleanup();
    diskWriterRef.current = null;
    cryptoKeyRef.current = null;
    nonceRef.current     = null;
    bitfieldRef.current  = null;
    isPausedRef.current  = false;
    useRelayRef.current  = false;
    transferLoopRunningRef.current = false;
    
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
            isEncrypted={isEncrypted}
            peerConnected={peerConnected}
            isRelayMode={useRelayRef.current}
            transferState={transferState}
            logs={logs}
            tunnelUrl={tunnelUrl}
            onFileSelect={(f) => { setSelectedFile(f); selectedFileRef.current = f; handleSend(f, false); }}
            onDisconnect={handleDisconnect}
            onAccept={handleAcceptFile}
            onTogglePause={togglePause}
            onReconnect={handleManualReconnect}
          />
        )}
      </main>
    </div>
  );
}
