import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../scripts/load_env.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Scoped test keys (never real credential names); restored after each test.
const KEYS = ["OB_TEST_ENV_A", "OB_TEST_ENV_B", "OB_TEST_ENV_C"];

function snapshot() {
  return Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
}

function restore(snap) {
  for (const k of KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function withTempFile(body, fn) {
  const path = join(here, `.tmp-env-${process.pid}-${Date.now()}.txt`);
  writeFileSync(path, body);
  try {
    return fn(path);
  } finally {
    unlinkSync(path);
  }
}

describe("loadEnvFile", () => {
  it("loads key=value lines and reports names only", () => {
    const snap = snapshot();
    try {
      const loaded = withTempFile("OB_TEST_ENV_A=0xabc\nOB_TEST_ENV_B=plain\n", loadEnvFile);
      assert.deepEqual(loaded, ["OB_TEST_ENV_A", "OB_TEST_ENV_B"]);
      assert.equal(process.env.OB_TEST_ENV_A, "0xabc");
      assert.equal(process.env.OB_TEST_ENV_B, "plain");
    } finally {
      restore(snap);
    }
  });

  it("handles quotes, export prefix, comments, blanks, and skips malformed lines", () => {
    const snap = snapshot();
    try {
      const body = [
        "# comment",
        "",
        "   ",
        'OB_TEST_ENV_A="quoted value"',
        "OB_TEST_ENV_B='single'",
        "export OB_TEST_ENV_C=0x123",
        "no-equals-here",
        "=no-key",
        "9BAD=oops",
        "ALSO BAD=oops",
      ].join("\n");
      const loaded = withTempFile(body, loadEnvFile);
      assert.deepEqual(loaded, ["OB_TEST_ENV_A", "OB_TEST_ENV_B", "OB_TEST_ENV_C"]);
      assert.equal(process.env.OB_TEST_ENV_A, "quoted value");
      assert.equal(process.env.OB_TEST_ENV_B, "single");
      assert.equal(process.env.OB_TEST_ENV_C, "0x123");
      assert.equal(process.env["ALSO BAD"], undefined);
    } finally {
      restore(snap);
    }
  });

  it("never overrides a non-empty variable, but fills empty ones", () => {
    const snap = snapshot();
    try {
      process.env.OB_TEST_ENV_A = "shell-wins";
      process.env.OB_TEST_ENV_B = "";
      const loaded = withTempFile("OB_TEST_ENV_A=file\nOB_TEST_ENV_B=file\n", loadEnvFile);
      assert.deepEqual(loaded, ["OB_TEST_ENV_B"]);
      assert.equal(process.env.OB_TEST_ENV_A, "shell-wins");
      assert.equal(process.env.OB_TEST_ENV_B, "file");
    } finally {
      restore(snap);
    }
  });

  it("is a no-op for a missing file", () => {
    assert.deepEqual(loadEnvFile(join(here, ".tmp-does-not-exist-xyz")), []);
  });
});
