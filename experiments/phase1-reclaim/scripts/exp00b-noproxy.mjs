// EXP-00b control: is sandbox egress proxy-mediated or direct?
// Runs WITHOUT proxy env vars: HTTPS fetch + WSS:443 + WSS:444, short timeouts.
const show = (label, ms, extra) => console.log(`${label}: ${extra} (${(ms / 1000).toFixed(1)}s)`);
console.log('proxy env present:', JSON.stringify({ https: process.env.HTTPS_PROXY || null, http: process.env.HTTP_PROXY || null }));
let t0 = Date.now();
try {
  const r = await fetch('https://api.github.com/zen', { headers: { 'User-Agent': 'exp00b' }, signal: AbortSignal.timeout(25000) });
  show('HTTPS', Date.now() - t0, `HTTP ${r.status}`);
} catch (e) {
  show('HTTPS', Date.now() - t0, `FAIL ${e.message} cause=${e.cause?.code || e.cause?.message}`);
}
for (const url of ['wss://attestor.reclaimprotocol.org/ws', 'wss://attestor.reclaimprotocol.org:444/ws']) {
  t0 = Date.now();
  await new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { show('WSS ' + url, Date.now() - t0, 'ctor threw ' + e.message); resolve(); return; }
    const t = setTimeout(() => { show('WSS ' + url, Date.now() - t0, 'TIMEOUT'); try { ws.close(); } catch {} resolve(); }, 20000);
    ws.onopen = () => { show('WSS ' + url, Date.now() - t0, 'OPEN'); clearTimeout(t); try { ws.close(); } catch {} resolve(); };
    ws.onerror = (ev) => { show('WSS ' + url, Date.now() - t0, 'error ' + (ev?.message || ev?.type)); clearTimeout(t); resolve(); };
  });
}
process.exit(0);
