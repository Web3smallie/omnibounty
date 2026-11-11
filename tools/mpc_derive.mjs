// OmniBounty MPC voucher-key derivation verifier (read-only).
//
// 1. Fetches the live root key (`public_key`) and the derived voucher key
//    (`derived_public_key`) from v1.signer-prod.testnet.
// 2. Independently re-derives the voucher key from the root key using the
//    published KDF (tweak = sha3_256(prefix || predecessor || "," || path),
//    derived = root + tweak*G) and FAILS if it does not match the view.
// 3. Prints the voucher ETH address (keccak256(derived)[12:]) for
//    `set_mpc_signer` / `setMpcSigner`.
//
// Usage:
//   node tools/mpc_derive.mjs [predecessor] [path]
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { secp256k1 } = require("../relayer/node_modules/@noble/curves/secp256k1.js");
const { sha3_256 } = require("../relayer/node_modules/@noble/hashes/sha3.js");
const { keccak256 } = require("../relayer/node_modules/ethers");

const NEAR_RPC = "https://rpc.testnet.near.org";
const MPC_ACCOUNT = "v1.signer-prod.testnet";
const KDF_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`bad base58 char: ${ch}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = Buffer.from(hex, "hex");
  let leading = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    leading++;
  }
  return Buffer.concat([Buffer.alloc(leading), body]);
}

function parseMpcKey(s, label) {
  const [prefix, data] = s.split(":");
  if (prefix !== "secp256k1" || !data) throw new Error(`bad ${label} key: ${s}`);
  const raw = b58decode(data);
  if (raw.length !== 64) throw new Error(`${label} key is ${raw.length} bytes, want 64`);
  return raw;
}

async function view(method, args) {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: MPC_ACCOUNT,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = await res.json();
  if (!body.result || !body.result.result) throw new Error(`${method}: ${JSON.stringify(body).slice(0, 300)}`);
  return JSON.parse(Buffer.from(body.result.result).toString());
}

const predecessor = process.argv[2] || "v2.omnibounty.testnet";
const path = process.argv[3] || "omnibounty-voucher-v1";

const rootStr = await view("public_key", { domain_id: null });
const derivedStr = await view("derived_public_key", { path, predecessor, domain_id: null });
const root = parseMpcKey(rootStr, "root");
const derived = parseMpcKey(derivedStr, "derived");

// Independent KDF check: derived == root + sha3_256(prefix||pred||","||path)*G.
const tweak = Buffer.from(sha3_256(`${KDF_PREFIX}${predecessor},${path}`));
const recomputed = secp256k1.ProjectivePoint.fromHex("04" + root.toString("hex"))
  .add(secp256k1.ProjectivePoint.BASE.multiply(BigInt("0x" + tweak.toString("hex"))))
  .toRawBytes(false)
  .slice(1);
if (!Buffer.from(recomputed).equals(derived)) {
  console.error("KDF MISMATCH: recomputed key differs from derived_public_key view");
  console.error(`root:     ${root.toString("hex")}`);
  console.error(`tweak:    ${tweak.toString("hex")}`);
  console.error(`expected: ${derived.toString("hex")}`);
  console.error(`got:      ${Buffer.from(recomputed).toString("hex")}`);
  process.exit(1);
}

const address = "0x" + Buffer.from(keccak256(derived).slice(2), "hex").subarray(-20).toString("hex");
console.log(JSON.stringify({
  predecessor,
  path,
  rootKey: rootStr,
  derivedKey: derivedStr,
  tweak: "0x" + tweak.toString("hex"),
  kdfCheck: "MATCH",
  voucherAddress: address,
}, null, 2));
