// Minimal .env file loader for server-side scripts (no dependencies).
//
// Reads KEY=VALUE lines and exports them into process.env. Variables that
// are already set to a non-empty value are never overridden, so
// shell-provided variables always take precedence over the file. A missing
// file is a silent no-op (shell-only usage keeps working).
//
// Supported line shapes: KEY=value, KEY="quoted value", KEY='quoted',
// export KEY=value. Blank lines and `#` comments are ignored. Values are
// taken literally (no escape processing); only one pair of surrounding
// quotes is stripped. Malformed lines are skipped, never repaired.
//
// Returns the names of the variables set (names only — never values), so
// callers and tests can confirm loading without touching secrets.
import { readFileSync } from "node:fs";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw new Error(`cannot read env file ${path}: ${e.message}`);
  }
  const loaded = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}
