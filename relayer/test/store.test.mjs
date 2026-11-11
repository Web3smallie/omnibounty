import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { StateStore } from "../src/store.mjs";

const tmpdir = (() => {
  const d = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
  mkdirSync(d, { recursive: true });
  return d;
})();

describe("store", () => {
  it("round-trips relayed markers", () => {
    const path = join(tmpdir, `ob-relay-${Date.now()}-a.json`);
    const s = new StateStore(path);
    assert.equal(s.isRelayed("0xabc"), false);
    s.markRelayed("0xABC", "0xtx");
    assert.equal(s.isRelayed("0xabc"), true);
    const s2 = new StateStore(path);
    assert.equal(s2.isRelayed("0xabc"), true);
  });

  it("starts empty on corrupt state", () => {
    const path = join(tmpdir, `ob-relay-${Date.now()}-b.json`);
    writeFileSync(path, "{not json");
    const s = new StateStore(path);
    assert.equal(s.isRelayed("0xabc"), false);
  });
});

