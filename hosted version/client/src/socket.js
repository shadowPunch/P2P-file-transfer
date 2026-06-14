import { io } from "socket.io-client";

// In the hosted architecture, the backend (Render) is separate from the frontend (Vercel).
// We use Vite's environment variables to configure this URL.
// Fallback to localhost:3001 for local development if not set.
const SIGNAL_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

export const socket = io(SIGNAL_URL, {
  autoConnect: false,       // we connect manually after user action
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
