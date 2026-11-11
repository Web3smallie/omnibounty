// Fixture integrity checker: recomputes every committed test vector from
// its inputs and asserts equality. Guards against fixture tampering and
// documents the exact derivation of each value.
//
// Run: npm run check   (from tools/)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { ethers } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata");
const load = (n) => JSON.parse(readFileSync(join(root, n)));
let failures = 0;
const check = (label, cond, extra = "") => {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${label} ${extra}`);
  } else {
    console.log(`ok ${label}`);
  }
};

const identOf = (provider, params, ctx) => {
  const c = ctx && ctx.length > 0 ? canonicalize(JSON.parse(ctx)) : "";
  return ethers.keccak256(ethers.toUtf8Bytes(`${provider}\n${params}\n${c}`)).toLowerCase();
};
const signData = (id, owner, ts, epoch) =>
  [id, owner.toLowerCase(), String(ts), String(epoch)].join("\n");

// -- reclaim.json -----------------------------------------------------------
{
  const fx = load("reclaim.json");
  const s = fx.spike;
  check("spike.identifier", identOf("http", s.claimInfo.parameters, s.claimInfo.context) === s.expectedIdentifier);
  check("spike.signData", signData(s.claim.identifier, s.claim.owner, s.claim.timestampS, s.claim.epoch) === s.expectedSignData);
  check(
    "spike.recovery",
    ethers.verifyMessage(s.expectedSignData, s.signatures[0]).toLowerCase() === s.expectedSigner
  );
  const st = fx.steam;
  check(
    "steam.sdk-style-identifier",
    identOf("http", st.claimInfo.parameters, st.claimInfo.context) === st.expectedIdentifierSdkStyle
  );
  check(
    "steam.recovery-over-stored",
    ethers.verifyMessage(st.expectedSignDataOverStored, st.signatures[0]).toLowerCase() === st.expectedSigner
  );
  check("steam.stored-equals-sdk-style", st.expectedStoredIdentifier === st.expectedIdentifierSdkStyle);
}

// -- canon.json --------------------------------------------------------------
{
  const fx = load("canon.json");
  for (const c of fx.cases) {
    check(`canon.${c.name}`, canonicalize(JSON.parse(c.input)) === c.canonical);
  }
}

// -- normalize.json ----------------------------------------------------------
{
  const fx = load("normalize.json");
  const norm = (s, n) => {
    if (!s) return null;
    const body = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
    if (body.length !== n * 2 || !/^[0-9a-fA-F]+$/.test(body)) return null;
    return body.toLowerCase();
  };
  for (const [field, n] of [["identifier", 32], ["owner", 20], ["signature", 65]]) {
    for (const c of fx[field]) {
      check(`normalize.${field}.${c.reason}`, norm(c.input, n) === c.expected, JSON.stringify(c.input));
    }
  }
  const vmap = (v) => (v === 0 || v === 1 ? v : v === 27 ? 0 : v === 28 ? 1 : null);
  for (const c of fx.recoveryId) {
    check(`normalize.v${c.v}`, vmap(c.v) === c.expected);
  }
}

// -- eip712.json ---------------------------------------------------------------
{
  const fx = load("eip712.json");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const vth = ethers.keccak256(
    ethers.toUtf8Bytes("Voucher(uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow)")
  );
  check("eip712.typehash", vth.toLowerCase() === fx.voucherTypehash.toLowerCase());
  const dth = ethers.keccak256(
    ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  );
  const ds = ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [dth, ethers.keccak256(ethers.toUtf8Bytes(fx.domain.name)), ethers.keccak256(ethers.toUtf8Bytes(fx.domain.version)), fx.domain.chainId, fx.domain.verifyingContract]
    )
  );
  check("eip712.domainSeparator", ds.toLowerCase() === fx.domainSeparator.toLowerCase());
  for (const e of fx.vouchers) {
    const v = e.value;
    const sh = ethers.keccak256(
      coder.encode(
        ["bytes32", "uint256", "address", "address", "uint256", "uint256", "uint256", "uint256", "address"],
        [vth, v.bountyId, v.recipient, v.token, v.amount, v.nonce, v.expiry, v.chainId, v.escrow]
      )
    );
    const digest = ethers.keccak256(ethers.concat(["0x1901", ds, sh]));
    check(`eip712.${e.name}.structHash`, sh.toLowerCase() === e.structHash.toLowerCase());
    check(`eip712.${e.name}.digest`, digest.toLowerCase() === e.digest.toLowerCase());
    check(
      `eip712.${e.name}.signer`,
      ethers.recoverAddress(digest, e.signature).toLowerCase() === e.signer.toLowerCase()
    );
  }
}

// -- e2e_claim.json -------------------------------------------------------------
{
  const fx = load("e2e_claim.json");
  const p = fx.proof;
  check(
    "e2e.identifier",
    identOf(p.claimInfo.provider, p.claimInfo.parameters, p.claimInfo.context) === p.signedClaim.claim.identifier.toLowerCase()
  );
  const sd = signData(
    p.signedClaim.claim.identifier,
    p.signedClaim.claim.owner,
    p.signedClaim.claim.timestampS,
    p.signedClaim.claim.epoch
  );
  check(
    "e2e.witness",
    ethers.verifyMessage(sd, p.signedClaim.signatures[0]).toLowerCase() === fx.witness
  );
  // Voucher digest recomputation.
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const vth = ethers.keccak256(
    ethers.toUtf8Bytes("Voucher(uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow)")
  );
  const v = fx.voucher;
  const sh = ethers.keccak256(
    coder.encode(
      ["bytes32", "uint256", "address", "address", "uint256", "uint256", "uint256", "uint256", "address"],
      [vth, v.bountyId, v.recipient, v.token, v.amount, v.nonce, v.expiry, v.chainId, v.escrow]
    )
  );
  check("e2e.structHash", sh.toLowerCase() === fx.structHash.toLowerCase());
  // MPC response: EXACT v3.18.0 envelope (scheme tag + compressed R).
  check("e2e.mpc.scheme", fx.mpcResponse.scheme === "Secp256k1");
  const P = 2n ** 256n - 2n ** 32n - 977n;
  const pt = fx.mpcResponse.big_r.affine_point.toLowerCase();
  check("e2e.mpc.compressed", pt.length === 66 && (pt.startsWith("02") || pt.startsWith("03")));
  check("e2e.mpc.prefix-parity", (pt.startsWith("03") ? 1 : 0) === fx.mpcResponse.recovery_id);
  const rx = BigInt("0x" + pt.slice(2));
  // Re-derive y from (x, parity) and require the point on-curve.
  const modPow = (b, e, m) => {
    let r = 1n;
    b %= m;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % m;
      b = (b * b) % m;
      e >>= 1n;
    }
    return r;
  };
  let ry = modPow((rx ** 3n + 7n) % P, (P + 1n) / 4n, P);
  if ((ry & 1n) !== BigInt(fx.mpcResponse.recovery_id)) ry = P - ry;
  check("e2e.mpc.on-curve", (ry * ry) % P === (rx ** 3n + 7n) % P);
  check("e2e.mpc.scalar-hex", /^[0-9a-f]{64}$/.test(fx.mpcResponse.s.scalar.toLowerCase()));
  const sig = { r: "0x" + pt.slice(2), s: "0x" + fx.mpcResponse.s.scalar.replace(/^0x/, ""), v: fx.mpcResponse.recovery_id === 1 ? 28 : 27 };
  check(
    "e2e.mpc.signer",
    ethers.recoverAddress(fx.digest, sig).toLowerCase() === fx.mpcSigner
  );
}

if (failures > 0) {
  console.error(`${failures} fixture check(s) FAILED`);
  process.exit(1);
}
console.log("all fixture checks passed");
