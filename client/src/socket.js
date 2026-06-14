import { io } from "socket.io-client";

// In the unified architecture, the server serving the React app is the same 
// server handling WebSockets. Therefore, a relative path "/" correctly resolves
// to localhost when in Electron, and correctly resolves to the Ngrok URL for receivers.
const SIGNAL_URL = "/";

export const socket = io(SIGNAL_URL, {
  autoConnect: false,       // we connect manually after user action
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
