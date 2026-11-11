// Persistent relayer state: which digests were relayed (tx hash) or skipped.
// The escrow's `usedVoucher` mapping is ground truth; this file is a cache
// that prevents resubmission attempts across restarts.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export class StateStore {
  constructor(path) {
    this.path = path;
    this.state = { relayed: {}, skipped: {} };
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        if (raw && typeof raw === "object") {
          this.state.relayed = raw.relayed ?? {};
          this.state.skipped = raw.skipped ?? {};
        }
      } catch {
        // Corrupt state file: start empty rather than crash or misbehave.
        this.state = { relayed: {}, skipped: {} };
      }
    }
  }

  save() {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  isRelayed(digest) {
    return Boolean(this.state.relayed[digest.toLowerCase()]);
  }

  markRelayed(digest, txHash) {
    this.state.relayed[digest.toLowerCase()] = {
      txHash,
      at: new Date().toISOString(),
    };
    this.save();
  }

  markSkipped(digest, reason) {
    this.state.skipped[digest.toLowerCase()] = {
      reason,
      at: new Date().toISOString(),
    };
    this.save();
  }
}
