'use strict';
/**
 * Content hashes of files kept between runs, keyed by absolute path and trusted only while size and mtime are the same
 * (git's index does the same). An entry whose mtime is within RACY_MS of the moment the cache was saved is dropped on
 * load: a write in the same clock tick would keep size and mtime and would otherwise hide a change.
 *
 * Shared by the test memo (cli/lib/test-trace.js) and the tree digest (cli/lib/factory/hash.js), ADR-0021.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A file that changed this close to the save may change again within the same mtime tick: never trusted from the cache. */
const RACY_MS = 2000;

function sha(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

class FileHashCache {
  constructor(file = null) {
    this.file = file;
    this.entries = new Map();
    this.dirty = false;
    if (!file) return;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored && stored.schema === 1 && Array.isArray(stored.entries)) {
        for (const [abs, size, mtime, hash] of stored.entries) {
          if (mtime < stored.savedAt - RACY_MS) this.entries.set(abs, { size, mtime, hash });
        }
      }
    } catch { /* no cache yet, or an unreadable one: every file is hashed again */ }
  }

  hashOf(absolute, stat) {
    const known = this.entries.get(absolute);
    if (known && known.size === stat.size && known.mtime === stat.mtimeMs) return known.hash;
    const hash = sha(fs.readFileSync(absolute));
    this.entries.set(absolute, { size: stat.size, mtime: stat.mtimeMs, hash });
    this.dirty = true;
    return hash;
  }

  save() {
    if (!this.file || !this.dirty) return;
    const entries = [...this.entries].map(([abs, item]) => [abs, item.size, item.mtime, item.hash]);
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, savedAt: Date.now(), entries }));
      fs.renameSync(temporary, this.file);
      this.dirty = false;
    } catch { try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ } }
  }
}

/** Where the shared caches live: INFRA_CACHE_DIR, else ~/.infra-cache (a junction to the dev drive on this host). */
function infraCacheDir(env = process.env) {
  return env.INFRA_CACHE_DIR || path.join(os.homedir(), '.infra-cache');
}

module.exports = { FileHashCache, RACY_MS, infraCacheDir, sha };
