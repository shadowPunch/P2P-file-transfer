import { useRef, useState, useEffect } from "react";
import { formatBytes, formatSpeed, fileIcon, copyToClipboard } from "../utils";

export default function TransferScreen({
  role,
  roomId,
  peerConnected,
  isEncrypted,
  transferState,   // { phase, progress, speed, bytesDone, totalBytes, filename, filesize, chunksDone, totalChunks, hashVerified }
  logs,
  onFileSelect,
  onSend,
  onDisconnect,
  downloadRef,
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
    const fullUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}${window.location.hash}`;
    await copyToClipboard(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const {
    phase, progress, speed, bytesDone, totalBytes,
    filename, filesize, chunksDone, totalChunks, hashVerified,
  } = transferState;

  const isSender    = role === "sender";
  const isIdle      = phase === "idle";
  const isSending   = phase === "sending";
  const isReceiving = phase === "receiving";
  const isResuming  = phase === "resuming";
  const isDone      = phase === "done";
  const isError     = phase === "error";
  const isActive    = isSending || isReceiving || isResuming;

  const pctStr  = `${Math.round(progress)}%`;
  const barDone = progress >= 100;

  // Progress bar color class
  const barClass = isResuming ? "resuming" : barDone ? "done" : "";

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
          {isEncrypted && (
            <span className="encrypt-badge" title="AES-GCM 256-bit zero-knowledge encryption">
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
          className={`copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopyLink}
          style={{ fontSize: "0.8rem", padding: "4px 10px" }}
        >
          {copied ? "✓ copied" : "copy link"}
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
              <p className="drop-zone-hint">Any file type · Large files via OPFS streaming · AES-GCM encrypted</p>
            </div>
          ) : (
            <div className="drop-zone has-file" style={{ padding: "16px 20px", cursor: "default" }}>
              <div className="file-info" style={{ background: "transparent", border: "none", padding: 0 }}>
                <div className="file-icon">{fileIcon(selectedFile.name)}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="file-name">{selectedFile.name}</div>
                  <div className="file-size">{formatBytes(selectedFile.size)}</div>
                </div>
                {!isActive && !isDone && (
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

          {selectedFile && !isActive && !isDone && (
            <button
              id="btn-send-file"
              className="btn btn-primary btn-full"
              onClick={() => onSend(selectedFile)}
              disabled={!peerConnected || isActive}
            >
              {!peerConnected
                ? <span>Waiting for peer<span className="waiting-dots" /></span>
                : "Send file 🔒 →"}
            </button>
          )}
        </>
      )}

      {/* ── Receiver: idle wait ── */}
      {!isSender && isIdle && (
        <div className="alert alert-info">
          <span>⏳</span>
          <span>Connected as receiver — waiting for sender to choose a file<span className="waiting-dots" /></span>
        </div>
      )}

      {/* ── Resuming notice ── */}
      {isResuming && (
        <div className="alert alert-warn">
          <span>🔄</span>
          <span>
            {isSender
              ? "Transfer paused — waiting for peer to reconnect…"
              : `Transfer paused at ${pctStr} — peer disconnected. Will resume automatically on reconnect.`}
          </span>
        </div>
      )}

      {/* ── Progress block ── */}
      {(isActive || isDone || isError) && (
        <div className="progress-block">
          {/* File info */}
          {(filename || filesize) && (
            <div className="file-info" style={{ marginBottom: 4 }}>
              <div className="file-icon">{fileIcon(filename)}</div>
              <div style={{ minWidth: 0 }}>
                <div className="file-name">{filename}</div>
                <div className="file-size">{formatBytes(filesize)}</div>
              </div>
              {isDone && hashVerified === true  && <span className="hash-badge ok"  title="SHA-256 verified">✓ verified</span>}
              {isDone && hashVerified === false && <span className="hash-badge err" title="SHA-256 mismatch">✕ mismatch</span>}
              {isDone && hashVerified === null  && <span style={{ marginLeft: "auto", color: "var(--accent-2)", fontSize: "1.1rem" }}>✓</span>}
            </div>
          )}

          <div className="progress-header">
            <span className="progress-label">
              {isSending   ? "sending"
               : isReceiving ? "receiving"
               : isResuming  ? "paused / resuming"
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
            {speed > 0 && <span>⚡ {formatSpeed(speed)}</span>}
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
          ✓ Transfer complete — receiver is downloading.
        </div>
      )}
      {isDone && !isSender && (
        <div className="alert alert-success">
          {hashVerified === false
            ? "⚠️ File received but SHA-256 hash did not match — file may be corrupted."
            : "✓ File received and verified — download started automatically."}
        </div>
      )}

      {/* ── Error alert ── */}
      {isError && (
        <div className="alert alert-error">
          ✕ Transfer failed or peer disconnected. Check the log below.
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

      {/* Hidden download anchor */}
      <a ref={downloadRef} style={{ display: "none" }} aria-hidden="true">
        download
      </a>
    </div>
  );
}
