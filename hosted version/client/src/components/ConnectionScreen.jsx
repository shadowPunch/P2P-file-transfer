import { useState, useEffect } from "react";
import { generateRoomId } from "../utils";

export default function ConnectionScreen({ onJoin, isConnecting, isEncrypted }) {
  const [hasRoomInUrl, setHasRoomInUrl] = useState(false);
  const [roomIdFromUrl, setRoomIdFromUrl] = useState("");
  const [hasKeyInUrl, setHasKeyInUrl] = useState(false);

  // Check for ?room= and #key= in URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    const hash = window.location.hash;
    const hasKey = /[#&]key=([^&]+)/.test(hash);

    if (roomParam) {
      setHasRoomInUrl(true);
      setRoomIdFromUrl(roomParam.toUpperCase());
    }
    setHasKeyInUrl(hasKey);
  }, []);

  function handleAction(role) {
    if (role === "sender") {
      // Senders always create a new room. Ignore old URL parameters.
      const newRoomId = generateRoomId();
      onJoin(newRoomId, role);
    } else {
      // Receivers use the URL room if present.
      if (hasRoomInUrl) {
        if (!hasKeyInUrl) {
          alert("Missing encryption key! Please join using the full share link provided by the sender.");
          return;
        }
        onJoin(roomIdFromUrl, role);
      } else {
        const newRoomId = generateRoomId();
        onJoin(newRoomId, role);
      }
    }
  }

  return (
    <div className="connection-screen">
      <p className="card-title">start a transfer</p>

      {/* Encryption notice for users arriving via share link */}
      {hasKeyInUrl && (
        <div className="alert alert-success" style={{ marginBottom: 20 }}>
          <span>🔒</span>
          <span>
            Secure link detected! Select your role below to connect to the room.
          </span>
        </div>
      )}

      {!hasRoomInUrl && (
         <p className="share-link-hint" style={{ marginBottom: 20, textAlign: 'center' }}>
           Choose whether you want to send or receive a file. A secure link will be generated for you to share with the other person.
         </p>
      )}

      <div style={{ display: 'flex', gap: '16px', flexDirection: 'column' }}>
        <button
          className="btn btn-primary btn-full"
          onClick={() => handleAction("sender")}
          disabled={isConnecting}
          style={{ marginBottom: 0, padding: '16px', fontSize: '1.1rem' }}
        >
          {isConnecting ? (
            <span>Connecting<span className="waiting-dots" /></span>
          ) : (
            "📤 I want to Send a File"
          )}
        </button>

        <button
          className="btn btn-secondary btn-full"
          onClick={() => handleAction("receiver")}
          disabled={isConnecting}
          style={{ marginBottom: 0, padding: '16px', fontSize: '1.1rem' }}
        >
          {isConnecting ? (
            <span>Connecting<span className="waiting-dots" /></span>
          ) : (
            "📥 I want to Receive a File"
          )}
        </button>
      </div>

    </div>
  );
}
