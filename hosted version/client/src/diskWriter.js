/**
 * diskWriter.js — Direct-to-Disk streaming writer
 *
 * Prompts the user to select a save location using the File System Access API
 * and writes incoming chunks directly to the user's hard drive.
 * Includes fallback to OPFS if File System Access is not supported.
 * Tracks missing chunks using a Bitfield, and calculates a rolling MD5 hash.
 */

import { createIncrementalHash, updateHash, finalizeHash } from "./crypto";

export class DiskWriter {
  #fileHandle = null;
  #writable = null;
  #bytesWritten = 0;
  #chunkMap = new Map();
  #nextExpected = 0;
  #bitfield = null;
  #hasher = null;
  #totalChunks = 0;

  static async open(suggestedName, totalChunks, isFallbackToOpfs = false) {
    const instance = new DiskWriter();
    await instance._init(suggestedName, totalChunks, isFallbackToOpfs);
    return instance;
  }

  async _init(suggestedName, totalChunks, isFallbackToOpfs) {
    this.#totalChunks = totalChunks;
    // Uint8Array where each bit represents a chunk.
    this.#bitfield = new Uint8Array(Math.ceil(totalChunks / 8));
    this.#hasher = createIncrementalHash();

    if (isFallbackToOpfs || !window.showSaveFilePicker) {
      // OPFS Fallback
      const root = await navigator.storage.getDirectory();
      this.#fileHandle = await root.getFileHandle("p2p-share-incoming.tmp", { create: true });
    } else {
      // Direct to disk (User picks where to save)
      this.#fileHandle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: "Any file", accept: { "*/*": [] } }],
      });
    }

    this.#writable = await this.#fileHandle.createWritable();
  }

  /**
   * Write a decrypted chunk.
   * Updates the bitfield. Flushes to disk and hash incrementally.
   */
  async write(chunkIndex, data) {
    // Update bitfield
    const byteIdx = Math.floor(chunkIndex / 8);
    const bitIdx = chunkIndex % 8;
    this.#bitfield[byteIdx] |= (1 << bitIdx);

    // Buffer chunk for sequential flushing
    this.#chunkMap.set(chunkIndex, data);

    // Flush any contiguous run starting from nextExpected
    while (this.#chunkMap.has(this.#nextExpected)) {
      const buf = this.#chunkMap.get(this.#nextExpected);
      this.#chunkMap.delete(this.#nextExpected);
      
      await this.#writable.write(buf);
      updateHash(this.#hasher, buf);
      
      this.#bytesWritten += buf.byteLength;
      this.#nextExpected++;
    }
  }

  get bytesWritten() {
    return this.#bytesWritten;
  }

  /**
   * Get the current bitfield to send back to the sender for resuming.
   * Converts Uint8Array to a regular array or base64 so it can be sent via JSON.
   */
  getBitfieldArray() {
    return Array.from(this.#bitfield);
  }

  /** Check if a chunk has been received according to the bitfield. */
  hasChunk(chunkIndex) {
    const byteIdx = Math.floor(chunkIndex / 8);
    const bitIdx = chunkIndex % 8;
    return (this.#bitfield[byteIdx] & (1 << bitIdx)) !== 0;
  }

  /**
   * Close the writable stream and return the final MD5 hash and file handle.
   */
  async finalize(filename, mimeType = "application/octet-stream") {
    await this.#writable.close();
    this.#writable = null;
    const finalHash = finalizeHash(this.#hasher);

    let file = null;
    try {
      file = await this.#fileHandle.getFile();
      // If OPFS, rename it
      if (file.name === "p2p-share-incoming.tmp") {
        file = new File([file], filename, { type: mimeType });
      }
    } catch (e) {
      console.warn("Could not get file from handle", e);
    }
    
    return { file, hash: finalHash, handle: this.#fileHandle };
  }

  async cleanup() {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("p2p-share-incoming.tmp");
    } catch {
      // Non-fatal
    }
  }
}
