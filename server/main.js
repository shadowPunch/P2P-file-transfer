const { app, BrowserWindow, ipcMain, clipboard } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

// ─── Determine the correct path to the compiled React bundle ────────────────
// In development:  __dirname/dist  (source tree, served by express.static)
// In packaged app: electron-builder's asarUnpack places it at
//                  <resources>/app.asar.unpacked/dist
//                  which is accessible via process.resourcesPath.
const distPath = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked", "dist")
  : path.join(__dirname, "dist");

// Inject the resolved path into the global scope so server.js can read it
// before any express.static() call is made.
global.electronDistPath = distPath;

// ─── Start the Express / Socket.io signaling server ─────────────────────────
// server.js exports a `serverReady` Promise that resolves once the HTTP
// server is actually bound and listening — we use it below.
const { serverReady } = require("./server.js");

// ─── Chromium flags required for Linux desktop (non-terminal) launches ───────
// --no-sandbox: required for packaged Electron on Linux without user namespaces.
app.commandLine.appendSwitch("no-sandbox");

// --disable-dev-shm-usage: use /tmp instead of /dev/shm for shared memory.
app.commandLine.appendSwitch("disable-dev-shm-usage");

// --no-zygote: Chromium's zygote is a pre-forked process that spawns the GPU
// and Compositor child processes. Those children inherit the AppArmor profile
// loaded by the .deb package (which only grants 'userns'), causing ESRCH when
// they try to create shared memory in /tmp or /dev/shm.
// Disabling the zygote makes Chromium spawn helpers directly, bypassing the
// broken profile inheritance.
app.commandLine.appendSwitch("no-zygote");

// Disable hardware acceleration to prevent blank screens caused by
// incompatible GPU drivers on many Linux desktop environments.
app.disableHardwareAcceleration();

let mainWindow;
let publicUrl = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    backgroundColor: "#1a1a1a",
  });

  // Forward renderer console messages to main-process stdout for post-install
  // debugging via journalctl. Filter out any line containing the encryption key
  // fragment so it never appears in system logs.
  mainWindow.webContents.on("console-message", (_ev, level, message, line, sourceId) => {
    if (message.includes("key=")) return; // Never log encryption key fragments
    const prefix = ["log", "warn", "error"][level] ?? "log";
    console[prefix](`[RENDERER] ${message} (at ${sourceId}:${line})`);
  });

  // ── Load the UI ────────────────────────────────────────────────────────────
  // By the time createWindow() is called the server is already listening
  // (we awaited serverReady below), so this should succeed on the first try.
  // The retry loop is kept as a safety net for very slow systems.
  const localUrl = `http://localhost:${process.env.PORT || 3001}`;

  const loadUI = () => {
    mainWindow.loadURL(localUrl).catch((err) => {
      console.warn(`[main] UI load failed (${err.code}), retrying in 500ms…`);
      setTimeout(loadUI, 500);
    });
  };
  loadUI();

  // ── SSH tunnel (localhost.run) ──────────────────────────────────────────────
  const startSshTunnel = () => {
    console.log("[main] Starting anonymous SSH tunnel (localhost.run)…");
    const ssh = spawn("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ServerAliveInterval=60",
      "-R", "80:localhost:3001",
      "nokey@localhost.run",
    ]);

    ssh.stdout.on("data", (data) => {
      const output = data.toString();
      const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.lhr\.life/);
      if (match && !publicUrl) {
        publicUrl = match[0];
        console.log(`[main] SSH Tunnel established: ${publicUrl}`);
        // Push the URL to all open renderer windows immediately
        // so the React UI doesn't have to poll and risk copying a stale localhost link.
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send("tunnel-url", publicUrl);
        });
      }
    });

    // Swallow stderr noise from SSH (host-key warnings etc.)
    ssh.stderr.on("data", () => {});

    ssh.on("error", (err) => {
      console.error("[main] SSH process failed to start:", err.message);
    });

    ssh.on("close", (code) => {
      console.log(`[main] SSH Tunnel closed with code ${code}`);
    });
  };

  startSshTunnel();
}

// ─── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Register IPC handlers before any window is created.
  ipcMain.handle("get-public-url", () => publicUrl);

  ipcMain.on("copy-to-clipboard", (_event, text) => {
    clipboard.writeText(text);
  });

  // Wait until Express is actually listening before opening the window.
  // This eliminates the blank-screen race condition.
  console.log("[main] Waiting for signaling server to be ready…");
  await serverReady;
  console.log("[main] Server ready — creating window.");

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
