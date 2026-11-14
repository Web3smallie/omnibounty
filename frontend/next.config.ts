import type { NextConfig } from "next";
import path from "node:path";

// P2-6: Content Security Policy (REPORT-ONLY, not enforced).
//
// Every origin below was inventoried from the shipped code, not guessed:
// - connect-src: same-origin criteria artifacts + the two default RPC
//   endpoints from lib/config.ts (NEXT_PUBLIC_NEAR_RPC_URL,
//   NEXT_PUBLIC_BASE_RPC_URL) + https://h4n.app, the HERE wallet proxy
//   API used by non-injected HERE flows (@here-wallet/core proxyApi).
//   Deliberately excluded: api.github.com (prove scripts run in node,
//   the browser never fetches it), fastnear/helper hosts (only the
//   wallet-modal Ledger path touches them, and Ledger is not configured),
//   explorer and wallet sites (plain links / top-level navigation, which
//   CSP does not restrict).
// - frame-src: https://my.herewallet.app, the HERE widget connector
//   iframe used when the HOT extension is absent (WidgetStrategy
//   defaultUrl). No other frame is embedded.
// - style-src/font-src: bundled CSS plus the wallet modal's Google Fonts
//   import (Manrope), which ships in the served CSS bundle.
// - script-src 'self': all JS is bundled locally; no external scripts and
//   no eval/new Function in app or wallet code (verified by inspection).
//
// Why report-only: Next.js emits inline bootstrap scripts and React
// renders style attributes, both of which a strict policy without
// 'unsafe-inline' would block. The textbook nonce fix (middleware
// x-nonce) conflicts with the statically prerendered pages (/, 
// /bounties/new ship fixed HTML), so enforcement needs a dedicated
// follow-up: nonce middleware + dynamic rendering (or scoped
// 'unsafe-inline') + live wallet-flow verification. Until then this
// header only OBSERVES: violations appear in browser devtools without
// breaking NEAR/EVM wallet connection, signing, RPC, or Reclaim flows
// (Reclaim proof generation runs in node scripts; the browser only
// pastes and validates JSON, so CSP cannot affect it).
//
// Custom RPC deployments: if NEXT_PUBLIC_NEAR_RPC_URL or
// NEXT_PUBLIC_BASE_RPC_URL point anywhere but the defaults below,
// extend connect-src accordingly. No report-uri is configured (no
// collection endpoint exists); triage via devtools.
const REPORT_ONLY_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "connect-src 'self' https://rpc.testnet.near.org https://sepolia.base.org https://h4n.app",
  "img-src 'self'",
  "font-src 'self' https://fonts.gstatic.com",
  "frame-src https://my.herewallet.app",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A stray lockfile above the workspace confuses root inference; pin it.
  outputFileTracingRoot: path.resolve("./"),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy-Report-Only",
            value: REPORT_ONLY_CSP,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
