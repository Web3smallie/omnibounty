// Minimal HTTP health surface for hosting the relayer as a web service
// (e.g. Render free tier, which requires a PORT-bound HTTP server and
// suspends idle processes). Zero dependencies: node:http only.
//
// Design: liveness only, always HTTP 200 while the process is responsive.
// Diagnostics (last poll outcome, staleness) ride in the JSON body for
// monitors to interpret; the endpoint never 503s on RPC blips, because a
// host that restarts unhealthy instances would flap the service on every
// transient RPC outage. Nothing here touches polling, validation, or
// submission logic.
import http from "node:http";

export const HEALTH_PATHS = ["/health", "/"];

// Decide whether the process should serve HTTP. Pure function of argv+env
// so the gating rule is unit-testable: daemon mode with a valid PORT.
export function shouldStartServer(argv = process.argv, env = process.env) {
  if (argv.includes("--once")) return false;
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 && port < 65536;
}

export function resolvePort(env = process.env) {
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error(`invalid PORT: ${JSON.stringify(env.PORT)} (want 1-65535)`);
  }
  return port;
}

// Start the server. getStatus() must return a JSON-serializable object;
// if it throws, the request fails closed with 500 and the server (and
// the polling loop) keep running. Resolves once listening; rejects if
// the port cannot bind so a bad deploy fails loudly instead of hanging.
export function startHealthServer({ port, host = "0.0.0.0", getStatus, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const path = (req.url ?? "/").split("?")[0];
        if ((req.method === "GET" || req.method === "HEAD") && HEALTH_PATHS.includes(path)) {
          const body = JSON.stringify(getStatus());
          res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
          res.end(req.method === "HEAD" ? undefined : body);
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "not-found" }));
      } catch (e) {
        log(`health handler error: ${e.message ?? String(e)}`);
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "error" }));
        } catch {
          // Response already broken; nothing left to do.
        }
      }
    });
    const onRuntimeError = (e) => {
      // Post-listen errors (e.g. a dropped connection) must never take
      // down the polling loop.
      log(`health server error: ${e.message ?? String(e)}`);
    };
    const onBindError = (e) => {
      server.removeListener("error", onRuntimeError);
      reject(e);
    };
    // A bind failure surfaces as 'error' before 'listening'.
    server.once("error", onBindError);
    server.on("error", onRuntimeError);
    // Deliberately NOT unref'd: a started server holds the loop open like
    // any standard listener. Short-lived flows (--once, tests) either never
    // start one (see shouldStartServer) or close it explicitly.
    server.listen(port, host, () => {
      server.removeListener("error", onBindError);
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      log(`health listening on http://${host}:${actual}/health`);
      resolve({ server, url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actual}` });
    });
  });
}

// Graceful shutdown coordinator. Pure logic over injected handles (no
// direct process access) so every path is unit-testable; the entry point
// wires real process/signals. The 25s default grace fits inside Render's
// 30s default SIGTERM-to-SIGKILL window (verified in docs). Semantics:
// - first signal: stop scheduling new iterations, close the listener,
//   then exit(0) as soon as no iteration is in flight;
// - bounded grace: exit(0) anyway after graceMs (abandoning in-flight
//   work is safe: escrow usedVoucher is ground truth on the next boot);
// - repeated signals are ignored (no double-exit races).
export function createShutdownCoordinator({ isPolling, onStop, closeServer, exit, graceMs = 25000, log = () => {} }) {
  let shuttingDown = false;
  return {
    onSignal(signal) {
      if (shuttingDown) return "ignored";
      shuttingDown = true;
      log(`received ${signal}, shutting down`);
      onStop();
      try {
        closeServer();
      } catch (e) {
        log(`server close error: ${e.message ?? String(e)}`);
      }
      const force = setTimeout(() => {
        log("shutdown grace exceeded, exiting");
        exit(0);
      }, graceMs);
      if (typeof force.unref === "function") force.unref();
      const poll = setInterval(() => {
        if (!isPolling()) {
          clearInterval(poll);
          clearTimeout(force);
          exit(0);
        }
      }, 50);
      if (typeof poll.unref === "function") poll.unref();
      return "stopping";
    },
  };
}
