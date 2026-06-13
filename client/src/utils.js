/** Generate a random 6-char uppercase room ID, e.g. "X4K9PL" */
export function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/1/I ambiguity
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Human-readable file size */
export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Transfer speed */
export function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Elapsed seconds → "m:ss" */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Create a timestamped log entry */
export function logEntry(msg, type = "default") {
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2, "0")}:${now
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
  return { time, msg, type, id: Date.now() + Math.random() };
}

/** File extension → emoji icon */
export function fileIcon(filename) {
  const ext = filename?.split(".").pop()?.toLowerCase();
  const map = {
    pdf: "📄", zip: "🗜️", tar: "🗜️", gz: "🗜️",
    mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬",
    mp3: "🎵", wav: "🎵", flac: "🎵",
    jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", webp: "🖼️",
    js: "📜", ts: "📜", py: "📜", rb: "📜",
    txt: "📝", md: "📝",
    doc: "📃", docx: "📃", xls: "📊", xlsx: "📊",
  };
  return map[ext] || "📁";
}

/** Copy text to clipboard, returns promise */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      throw new Error("Clipboard API unavailable or non-secure context");
    }
  } catch {
    // Fallback for non-HTTPS local network testing
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "absolute";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      console.error("Fallback copy failed", e);
    }
    document.body.removeChild(el);
    return ok;
  }
}
