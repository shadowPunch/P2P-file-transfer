/**
 * opfsWriter.js — Origin Private File System streaming writer
 *
 * Used for large file transfers (>50 MB) to avoid holding the entire file
 * in a JS Array in RAM. Chunks are written to an OPFS file as they arrive,
 * and the final File handle is returned for download.
 *
 * Falls back to null if OPFS is unavailable (caller should use in-memory path).
 */

const OPFS_FILENAME = "p2p-share-incoming.tmp";

/**
 * Check whether OPFS is available in this browser.
 */
export function isOpfsAvailable() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

/**
 * OPFSWriter — streams incoming chunks directly to an OPFS file.
 *
 * Usage:
 *   const writer = await OPFSWriter.open();
 *   await writer.write(chunkIndex, decryptedBuffer);
 *   ...
 *   const file = await writer.finalize(filename, mimeType);
 *   // file is a File object you can pass to URL.createObjectURL()
 *   await writer.cleanup(); // optional — removes the temp file
 */
export class OPFSWriter {
  #fileHandle  = null;
  #writable    = null;
  #bytesWritten = 0;
  #chunkMap    = new Map(); // index → ArrayBuffer (for out-of-order chunks)
  #nextExpected = 0;

  static async open() {
    const instance = new OPFSWriter();
    await instance._init();
    return instance;
  }

  async _init() {
    const root         = await navigator.storage.getDirectory();
    this.#fileHandle   = await root.getFileHandle(OPFS_FILENAME, { create: true });
    this.#writable     = await this.#fileHandle.createWritable();
  }

  /**
   * Write a decrypted chunk.
   * Chunks may arrive slightly out of order; we buffer and flush in-order.
   */
  async write(chunkIndex, data) {
    this.#chunkMap.set(chunkIndex, data);

    // Flush any contiguous run starting from nextExpected
    while (this.#chunkMap.has(this.#nextExpected)) {
      const buf = this.#chunkMap.get(this.#nextExpected);
      this.#chunkMap.delete(this.#nextExpected);
      await this.#writable.write(buf);
      this.#bytesWritten += buf.byteLength;
      this.#nextExpected++;
    }
  }

  get bytesWritten() {
    return this.#bytesWritten;
  }

  /**
   * Close the writable stream and return a File object.
   * Call this once all chunks have been written.
   */
  async finalize(filename, mimeType = "application/octet-stream") {
    await this.#writable.close();
    this.#writable = null;
    const file = await this.#fileHandle.getFile();
    // Re-wrap as a named File (OPFS files have no meaningful name)
    return new File([file], filename, { type: mimeType });
  }

  /**
   * Delete the temporary OPFS file.
   * Call after the download URL has been created.
   */
  async cleanup() {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(OPFS_FILENAME);
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Convenience: create an object URL from an OPFSWriter-finalized File.
 * Caller is responsible for calling URL.revokeObjectURL() later.
 */
export function createDownloadUrl(file) {
  return URL.createObjectURL(file);
}
