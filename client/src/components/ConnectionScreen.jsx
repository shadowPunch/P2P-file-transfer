import { useState, useEffect } from "react";
import { generateRoomId, copyToClipboard } from "../utils";

export default function ConnectionScreen({ onJoin, isConnecting, isEncrypted }) {
  const [joinId,    setJoinId]    = useState("");
  const [newRoomId]               = useState(() => generateRoomId());
  const [copied,    setCopied]    = useState(false);
  const [hasKeyInUrl, setHasKeyInUrl] = useState(false);
  const [autoRoomId,  setAutoRoomId]  = useState("");

  // Check for ?room= and #key= in URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    const hash = window.location.hash;
    const hasKey = /[#&]key=([^&]+)/.test(hash);

    if (roomParam) {
      setJoinId(roomParam.toUpperCase());
      setAutoRoomId(roomParam.toUpperCase());
    }
    setHasKeyInUrl(hasKey);
  }, []);

  // Share URL includes key in hash (key is added to hash by App after room creation)
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${newRoomId}`;

  async function handleCopy() {
    // At this point the key may already be in window.location.hash (set by App)
    const fullUrl = `${window.location.origin}${window.location.pathname}?room=${newRoomId}${window.location.hash}`;
    await copyToClipboard(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleCreate() {
    onJoin(newRoomId, "sender");
  }

  function handleJoin(e) {
    e.preventDefault();
    const id = joinId.trim().toUpperCase();
    if (id.length < 4) return;
    
    if (!hasKeyInUrl) {
      alert("Missing encryption key! Please join using the full share link provided by the sender. Encrypted rooms cannot be joined by typing the room ID manually.");
      return;
    }
    
    onJoin(id, "receiver");
  }

  return (
    <div className="connection-screen">
      <p className="card-title">start a transfer</p>

      {/* Encryption notice for receivers arriving via share link */}
      {hasKeyInUrl && (
        <div className="alert alert-success" style={{ marginBottom: 16 }}>
          <span>🔒</span>
          <span>
            Encrypted room detected — your decryption key is in the URL.
            The server never sees your file data.
          </span>
        </div>
      )}

      {/* ── Create room ── */}
      <div className="room-display">
        <div>
          <div className="room-id-label">Your room ID</div>
          <div className="room-id-value">{newRoomId}</div>
        </div>
        <button
          className={`copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          aria-label="Copy share link"
          title="Copies the full share link including encryption key"
        >
          {copied ? "✓ copied" : "copy link"}
        </button>
      </div>

      <div className="share-link-box">
        <span className="share-link-url mono">{shareUrl}<span style={{ color: "var(--accent-2)" }}>#key=…</span></span>
      </div>

      <p className="share-link-hint">
        🔒 The encryption key is appended to the link after room creation.
      </p>

      <button
        className="btn btn-primary btn-full"
        onClick={handleCreate}
        disabled={isConnecting}
        id="btn-create-room"
        style={{ marginBottom: 0 }}
      >
        {isConnecting ? (
          <span>Connecting<span className="waiting-dots" /></span>
        ) : (
          "Create encrypted room →"
        )}
      </button>

      <div className="divider">or join existing</div>

      {/* ── Join room ── */}
      {autoRoomId && (
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          <span>📎</span>
          <span>Room ID pre-filled from share link: <strong>{autoRoomId}</strong></span>
        </div>
      )}

      <form onSubmit={handleJoin}>
        <div className="input-group">
          <input
            id="input-room-id"
            type="text"
            placeholder="ENTER ROOM ID"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value.toUpperCase())}
            maxLength={8}
            spellCheck={false}
            autoComplete="off"
            aria-label="Room ID to join"
          />
          <button
            id="btn-join-room"
            type="submit"
            className="btn btn-secondary"
            disabled={joinId.trim().length < 4 || isConnecting}
          >
            Join
          </button>
        </div>
      </form>
    </div>
  );
}
