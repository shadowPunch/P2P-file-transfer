import { useRef, useState, useEffect } from "react";
import { formatBytes, formatSpeed, fileIcon, copyToClipboard } from "../utils";

export default function TransferScreen({
  role,
  roomId,
  peerConnected,
  isEncrypted,
  isRelayMode,
  transferState,
  logs,
  tunnelUrl,
  onFileSelect,
  onSend,
  onDisconnect,
  onAccept,
  onTogglePause,
  onReconnect,
}) {
  const [dragOver,      setDragOver]      = useState(false);
  const [selectedFile,  setSelectedFile]  = useState(null);
  const [copied,        setCopied]        = useState(false);
  const logEndRef = useRef(null);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) pick(file);
  }

  function handleFileInput(e) {
    const file = e.target.files[0];
    if (file) pick(file);
  }

  function pick(file) {
    setSelectedFile(file);
    onFileSelect(file);
  }

  async function handleCopyLink() {
    // Don't allow copying until the public tunnel URL is available.
    // Using localhost would give the recipient a link that only works on
    // the sender's machine.
    if (!tunnelUrl) {
      alert("The public share link is not ready yet — SSH tunnel is still connecting. Please wait a moment and try again.");
      return;
    }
    const fullUrl = `${tunnelUrl}${window.location.pathname}?room=${roomId}${window.location.hash}`;
    if (window.electronAPI && window.electronAPI.copyToClipboard) {
      window.electronAPI.copyToClipboard(fullUrl);
    } else {
      await copyToClipboard(fullUrl);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const {
    phase, progress, speed, bytesDone, totalBytes,
    filename, filesize, chunksDone, totalChunks, hashVerified,
  } = transferState;

  const isSender         = role === "sender";
  const isIdle           = phase === "idle";
  const isPendingAccept  = phase === "pending-accept";
  const isSending        = phase === "sending";
  const isReceiving      = phase === "receiving";
  const isInterrupted    = phase === "interrupted";
  const isPaused         = phase === "paused";
  const isResuming       = phase === "resuming";
  const isDone           = phase === "done";
  const isError          = phase === "error";
  
  const isActive         = isSending || isReceiving || isResuming || isPaused;

  const pctStr  = `${Math.round(progress)}%`;
  const barDone = progress >= 100;

  // Progress bar color class
  const barClass = (isInterrupted || isPaused) ? "resuming" : barDone ? "done" : "";

  return (
    <div className="transfer-screen">

      {/* ── Header row ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className={`status-badge ${peerConnected ? "connected" : "waiting"}`}>
            <span className="dot" />
            {peerConnected ? "peer connected" : "waiting for peer"}
          </span>
          <span className={`role-tag ${role}`}>{role}</span>
          {/* Add a global indicator for WebSocket Relay mode */}
          {isRelayMode && (
             <span className="encrypt-badge" title="WebSocket Relay Mode Active" style={{ background: "var(--accent-2)", color: "var(--bg-1)" }}>
               🌐 relay mode
             </span>
          )}
          {isEncrypted && (
            <span className="encrypt-badge" title="End-to-End Encrypted">
              🔒 encrypted
            </span>
          )}
        </div>
        <button
          id="btn-leave-room"
          className="btn btn-danger"
          onClick={onDisconnect}
          style={{ padding: "6px 14px", fontSize: "0.8rem" }}
        >
          ✕ leave
        </button>
      </div>

      {/* ── Room info ── */}
      <div className="peer-panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="peer-panel-label" style={{ margin: 0 }}>Room</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.95rem", letterSpacing: "0.12em", color: "var(--accent)" }}>
            {roomId}
          </span>
        </div>
        <button
          className={`copy-btn ${copied ? "copied" : ""} ${!tunnelUrl ? "waiting" : ""}`}
          onClick={handleCopyLink}
          title={!tunnelUrl ? "SSH tunnel connecting… please wait" : `Copy: ${tunnelUrl}?room=${roomId}`}
          style={{ fontSize: "0.8rem", padding: "4px 10px", opacity: tunnelUrl ? 1 : 0.55 }}
        >
          {copied ? "✓ copied" : !tunnelUrl ? "⏳ tunnel…" : "copy link"}
        </button>
      </div>

      {/* ── Sender: file picker ── */}
      {isSender && (
        <>
          {!selectedFile ? (
            <div
              className={`drop-zone ${dragOver ? "drag-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <input
                id="file-input"
                type="file"
                onChange={handleFileInput}
                aria-label="Select file to share"
              />
              <div className="drop-zone-icon">📂</div>
              <p className="drop-zone-text">
                <strong>Click to browse</strong> or drag a file here
              </p>
              <p className="drop-zone-hint">Any file type · Direct Device-to-Device Transfer · End-to-End Encrypted</p>
            </div>
          ) : (
            <div className="drop-zone has-file" style={{ padding: "16px 20px", cursor: "default" }}>
              <div className="file-info" style={{ background: "transparent", border: "none", padding: 0 }}>
                <div className="file-icon">{fileIcon(selectedFile.name)}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="file-name">{selectedFile.name}</div>
                  <div className="file-size">{formatBytes(selectedFile.size)}</div>
                </div>
                {!isActive && !isDone && !isPendingAccept && (
                  <button
                    className="copy-btn"
                    style={{ marginLeft: "auto" }}
                    onClick={() => { setSelectedFile(null); onFileSelect(null); }}
                    aria-label="Clear selected file"
                  >
                    clear
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Receiver: pending accept ── */}
      {!isSender && isPendingAccept && (
        <div className="alert alert-info" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>📥</span>
            <span>Sender wants to send you a file:</span>
          </div>
          <div className="file-info" style={{ background: "var(--bg-3)", border: "1px solid var(--border-color)", padding: "12px" }}>
            <div className="file-icon">{fileIcon(filename)}</div>
            <div>
              <div className="file-name">{filename}</div>
              <div className="file-size">{formatBytes(filesize)}</div>
            </div>
          </div>
          <button className="btn btn-primary" onClick={onAccept}>
            Accept File (Choose Save Location)
          </button>
        </div>
      )}

      {/* ── Receiver: idle wait ── */}
      {!isSender && isIdle && (
        <div className="alert alert-info">
          <span>⏳</span>
          <span>Connected as receiver — waiting for sender to choose a file<span className="waiting-dots" /></span>
        </div>
      )}

      {/* ── Sender: waiting for receiver to accept ── */}
      {isSender && isPendingAccept && (
        <div className="alert alert-info">
          <span>⏳</span>
          <span>File selected. Waiting for receiver to accept and choose save location<span className="waiting-dots" /></span>
        </div>
      )}

      {/* ── Interrupted / Resuming Notice ── */}
      {isInterrupted && (
        <div className="alert alert-error" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <span>🔌</span> 
            <span style={{ marginLeft: 8 }}><strong>Connection Interrupted or Blocked!</strong> The network dropped or a strict firewall blocked P2P.</span>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
            <button className="btn btn-primary" onClick={() => onReconnect(false)} style={{ flex: 1 }}>
              Retry P2P Connection
            </button>
            <button className="btn btn-secondary" onClick={() => onReconnect(true)} style={{ flex: 1 }}>
              Use Relay Server (Bypass Firewall)
            </button>
          </div>
        </div>
      )}
      
      {isResuming && (
        <div className="alert alert-warn">
          <span>🔄</span> <span style={{ marginLeft: 8 }}>Attempting to reconnect to peer<span className="waiting-dots" /></span>
        </div>
      )}

      {/* ── Progress block ── */}
      {(isActive || isDone || isError || isPaused || isInterrupted) && !isPendingAccept && (
        <div className="progress-block">
          {/* File info */}
          {(filename || filesize) && (
            <div className="file-info" style={{ marginBottom: 4 }}>
              <div className="file-icon">{fileIcon(filename)}</div>
              <div style={{ minWidth: 0 }}>
                <div className="file-name">{filename}</div>
                <div className="file-size">{formatBytes(filesize)}</div>
              </div>
              
              {/* Pause / Resume Button */}
              {!isDone && !isError && !isInterrupted && (
                 <button 
                   className="copy-btn" 
                   style={{ marginLeft: "auto", background: isPaused ? "var(--accent)" : "transparent" }}
                   onClick={onTogglePause}
                 >
                   {isPaused ? "▶ Resume" : "⏸ Pause"}
                 </button>
              )}
            </div>
          )}

          <div className="progress-header">
            <span className="progress-label">
              {isSending   ? "sending"
               : isReceiving ? "receiving"
               : isInterrupted ? "interrupted"
               : isPaused  ? "paused"
               : isResuming ? "resuming"
               : isDone      ? "complete"
               : "error"}
            </span>
            <span className="progress-pct">{pctStr}</span>
          </div>

          <div className="progress-bar-track">
            <div
              className={`progress-bar-fill ${barClass}`}
              style={{ width: pctStr }}
            />
          </div>

          <div className="progress-meta">
            {speed > 0 && !isPaused && !isInterrupted && <span>⚡ {formatSpeed(speed)}</span>}
            {bytesDone > 0 && totalBytes > 0 && (
              <span>{formatBytes(bytesDone)} / {formatBytes(totalBytes)}</span>
            )}
            {totalChunks > 0 && (
              <span>chunk {chunksDone}/{totalChunks}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Success alert ── */}
      {isDone && isSender && (
        <div className="alert alert-success">
          ✓ Transfer complete — file successfully delivered!
        </div>
      )}
      {isDone && !isSender && (
        <div className="alert alert-success">
          ✓ File received and saved to disk!
        </div>
      )}

      {/* ── Error alert ── */}
      {isError && (
        <div className="alert alert-error">
          ✕ Transfer failed. Check the log below.
        </div>
      )}

      {/* ── Log console ── */}
      <div
        className="log-console"
        role="log"
        aria-live="polite"
        aria-label="Transfer log"
      >
        {logs.length === 0 && (
          <span style={{ color: "var(--text-3)" }}>// awaiting activity…</span>
        )}
        {logs.map((entry) => (
          <div className="log-line" key={entry.id}>
            <span className="log-time">{entry.time}</span>
            <span className={`log-msg ${entry.type}`}>{entry.msg}</span>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
