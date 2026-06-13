import { io } from "socket.io-client";

// Single socket instance shared across the app.
// In dev: Vite proxy routes /socket.io → :3001 (same origin, no CORS).
// In prod: set VITE_SIGNAL_URL to your deployed server URL.
const SIGNAL_URL =
  import.meta.env.VITE_SIGNAL_URL || window.location.origin;

export const socket = io(SIGNAL_URL, {
  autoConnect: false,       // we connect manually after user action
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
