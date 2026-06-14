import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    allowedHosts: true, // Allow all hosts so ngrok works
    proxy: {
      // Proxy socket.io WS + polling to the signaling server
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
