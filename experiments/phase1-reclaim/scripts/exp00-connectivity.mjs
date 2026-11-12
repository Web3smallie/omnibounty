// EXP-00: Reclaim reachability + Devtool app existence.
// - HTTPS egress to api.reclaimprotocol.org (proves fetch path).
// - App lookup by PUBLIC app id (proves the Devtool app record still exists
//   and is zk-fetch enabled). Prints status + app name only.
// - WSS handshake to the attestor (proves the proof-transport path).
// No secrets printed. No proofs generated. No chain interaction.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined && process.env[key] !== '') continue;
    process.env[key] = line.slice(line.indexOf('=') + 1).trim();
  }
}

loadEnvFile(join(ROOT, 'frontend', '.env.local'));

const appId = process.env.RECLAIM_APP_ID;
const hasSecret = !!process.env.RECLAIM_APP_SECRET;
console.log('node:', process.version);
console.log('appId present:', !!appId, '| appId prefix:', appId ? appId.slice(0, 10) + '…' : '(none)');
console.log('appSecret present:', hasSecret);
if (!appId) {
  console.log('ABORT: no RECLAIM_APP_ID available');
  process.exit(2);
}

// 1. HTTPS egress to the Reclaim app backend.
const lookupUrl = `https://api.reclaimprotocol.org/api/applications/sdk/get-zk-enabled-app/${appId}`;
try {
  const t0 = Date.now();
  const r = await fetch(lookupUrl);
  console.log(`APP LOOKUP: HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.status === 200) {
    const j = await r.json();
    console.log('APP LOOKUP: app name =', JSON.stringify(j?.application?.name));
  } else {
    console.log('APP LOOKUP: body =', (await r.text()).slice(0, 200));
  }
} catch (e) {
  console.log('APP LOOKUP FAILED:', e.message, '| cause:', e.cause?.code || e.cause?.message || e.cause);
}

// 2. WSS handshake to the attestor (connect + immediately close).
await new Promise((resolve) => {
  const t0 = Date.now();
  let ws;
  try {
    ws = new WebSocket('wss://attestor.reclaimprotocol.org/ws');
  } catch (e) {
    console.log('WSS: constructor threw:', e.message);
    resolve();
    return;
  }
  const t = setTimeout(() => {
    console.log(`WSS: timeout after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    try { ws.close(); } catch {}
    resolve();
  }, 25000);
  ws.onopen = () => {
    console.log(`WSS: OPEN in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    clearTimeout(t);
    try { ws.close(); } catch {}
    resolve();
  };
  ws.onerror = (ev) => {
    console.log(`WSS: error after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, ev?.message || ev?.type || 'unknown');
    clearTimeout(t);
    resolve();
  };
});
process.exit(0);
