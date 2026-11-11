// Oracle fixture generator for OmniBounty cross-implementation tests.
// Uses ethers.js v6 as the INDEPENDENT oracle: Rust (NEAR) and Solidity (Base)
// tests assert byte-equality against these committed fixtures.
//
// Run: npm run gen   (from tools/)
// Output: ../testdata/*.json  (committed to the repo)
//
// TEST-ONLY KEY WARNING: the fixed keys below are arbitrary deterministic
// test keys (NOT tied to any real account). They exist solely to produce
// deterministic test signatures. Production code NEVER embeds keys; the
// escrow/contract signers are deploy-time configuration.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { ethers } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata");
mkdirSync(root, { recursive: true });
const out = (name, obj) =>
  writeFileSync(join(root, name), JSON.stringify(obj, null, 2) + "\n");

// ---------------------------------------------------------------------------
// 1. Reclaim proof fixtures
// ---------------------------------------------------------------------------

function identifierOf(provider, parameters, context) {
  const canonCtx =
    context && context.length > 0
      ? canonicalize(JSON.parse(context))
      : "";
  const preimage = `${provider}\n${parameters}\n${canonCtx}`;
  return ethers.keccak256(ethers.toUtf8Bytes(preimage)).toLowerCase();
}

function signDataOf(identifier, owner, timestampS, epoch) {
  return [identifier, owner.toLowerCase(), String(timestampS), String(epoch)].join(
    "\n"
  );
}

// -- Spike proof: real attestor-signed GitHub PR proof (state=closed) --------
const spikeParams = JSON.stringify({
  body: "",
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  method: "GET",
  responseMatches: [{ type: "regex", value: '"state":"(?<state>.*?)"' }],
  responseRedactions: [],
  url: "https://api.github.com/repos/react/react/pulls/1",
});
const spikeCtx = JSON.stringify({
  extractedParameters: { state: "closed" },
  providerHash:
    "0x1107f0dc35e4c1a899dc33c33f7cd5e90053561adf356dacbbec4be56ca7d0b6",
});
const spikeId = "0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175";
const spikeOwner = "0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9";
const spikeTs = 1794129286;
const spikeSig =
  "0xe1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca648a7a9289898fdb80ade7e6de733f62b5ffed9293aa6586b9b19b43502038591c";
const spikeWitness = "0x244897572368eadf65bfbc5aec98d8e5443a9072";

// Self-check the oracle before emitting anything.
const recomputedSpikeId = identifierOf("http", spikeParams, spikeCtx);
if (recomputedSpikeId !== spikeId) {
  throw new Error(`oracle mismatch on spike identifier: ${recomputedSpikeId}`);
}
const spikeSignData = signDataOf(spikeId, spikeOwner, spikeTs, 1);
const recoveredSpike = ethers.verifyMessage(spikeSignData, spikeSig).toLowerCase();
if (recoveredSpike !== spikeWitness) {
  throw new Error(`oracle mismatch on spike recovery: ${recoveredSpike}`);
}

// -- Steam vector: the reference test from the Reclaim NEAR integration ------
const steamParams =
  '{"body":"","geoLocation":"in","method":"GET","responseMatches":[{"type":"contains","value":"_steamid\\">Steam ID: 76561199632643233</div>"}],"responseRedactions":[{"jsonPath":"","regex":"_steamid\\">Steam ID: (.*)</div>","xPath":"id(\\"responsive_page_template_content\\")/div[@class=\\"page_header_ctn\\"]/div[@class=\\"page_content\\"]/div[@class=\\"youraccount_steamid\\"]"}],"url":"https://store.steampowered.com/account/"}';
const steamCtx =
  '{"contextAddress":"user\'s address","contextMessage":"for acmecorp.com on 1st january"}';
const steamId = "531322a6c34e5a71296a5ee07af13f0c27b5b1e50616f816374aff6064daaf55";
const steamOwner = "e4c20c9f558160ec08106de300326f7e9c73fb7f";
const steamTs = 1710157447;
const steamSig =
  "52e2a591f51351c1883559f8b6c6264b9cb5984d0b7ccc805078571242166b357994460a1bf8f9903c4130f67d358d7d6e9a52df9a38c51db6a10574b946884c1b";
// NOTE (corrected): the reference vector's context IS canonical-key-ordered
// ("contextAddress" < "contextMessage" byte-wise), and its parameters are
// canonical too — so SDK-style hashing reproduces the stored identifier
// exactly. The oracle pins both values to lock this in.
const steamIdSdkStyle = identifierOf("http", steamParams, steamCtx);
const steamSignDataStored = [
  `0x${steamId}`,
  `0x${steamOwner}`,
  String(steamTs),
  "1",
].join("\n");
const recoveredSteam = ethers
  .verifyMessage(steamSignDataStored, `0x${steamSig}`)
  .toLowerCase();
if (recoveredSteam !== spikeWitness) {
  throw new Error(`oracle mismatch on steam recovery: ${recoveredSteam}`);
}

out("reclaim.json", {
  _comment:
    "Cross-implementation Reclaim fixtures. identifiers/signData are the SDK-canonical forms.",
  spike: {
    claimInfo: { provider: "http", parameters: spikeParams, context: spikeCtx },
    claim: {
      identifier: spikeId,
      owner: spikeOwner,
      epoch: 1,
      timestampS: spikeTs,
    },
    signatures: [spikeSig],
    expectedIdentifier: spikeId,
    expectedSignData: spikeSignData,
    expectedSigner: spikeWitness,
  },
  steam: {
    claimInfo: { provider: "http", parameters: steamParams, context: steamCtx },
    claim: {
      // Stored (attestor-era) identifier uses raw-context hashing.
      identifier: `0x${steamId}`,
      owner: `0x${steamOwner}`,
      epoch: 1,
      timestampS: steamTs,
    },
    signatures: [`0x${steamSig}`],
    expectedIdentifierSdkStyle: steamIdSdkStyle,
    expectedStoredIdentifier: `0x${steamId}`,
    expectedSignDataOverStored: steamSignDataStored,
    expectedSigner: spikeWitness,
  },
});

// ---------------------------------------------------------------------------
// 2. Canonical-JSON fixtures (algorithm: canonicalize@2.1.0)
// ---------------------------------------------------------------------------
const canonInputs = [
  ["nested", { b: 2, a: { d: [3, 2, 1], c: "x" } }],
  ["key_order", { zzz: 1, aaa: 2, mmm: 3 }],
  ["empty_object", {}],
  ["empty_array", { arr: [] }],
  ["bools_null", { t: true, f: false, n: null }],
  ["ints", { big: 9007199254740991, neg: -42, zero: 0 }],
  ["unicode", { emoji: "🪙é", cjk: "賞金" }],
  ["escapes", { q: 'a"b\\c', nl: "x\ny", tab: "p\tq", ctrl: "" }],
  ["deep", { l1: { l2: { l3: { l4: { v: "deep" } } } } }],
  ["array_of_objects", { items: [{ b: 1, a: 2 }, { d: 4, c: 3 }] }],
  ["exponent_int", { v: 1000000 }],
  ["float_int_valued", { v: 42.0 }],
  ["string_numbers", { v: "007", w: "1e3" }],
];
const canonCases = canonInputs.map(([name, value]) => ({
  name,
  input: JSON.stringify(value),
  canonical: canonicalize(value),
}));
// Duplicate-key raw input: JSON.parse keeps the LAST occurrence on both
// JS and serde_json. The oracle pins the post-parse canonical form.
const dupRaw = '{"b":1,"a":2,"b":3}';
canonCases.push({
  name: "duplicate_keys_last_wins",
  input: dupRaw,
  canonical: canonicalize(JSON.parse(dupRaw)),
});
out("canon.json", { cases: canonCases });

// ---------------------------------------------------------------------------
// 3. Normalizer fixtures
// ---------------------------------------------------------------------------
const ID = "94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175";
const OWNER = "cb234c6fc8abe3eb38e31eec6288b431e313d9b9";
const SIG =
  "e1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca648a7a9289898fdb80ade7e6de733f62b5ffed9293aa6586b9b19b43502038591c";
out("normalize.json", {
  _comment: "expected=null means the input MUST be rejected.",
  identifier: [
    { input: `0x${ID}`, expected: ID, reason: "sdk-native prefixed" },
    { input: ID, expected: ID, reason: "already canonical" },
    { input: `0x${ID.toUpperCase()}`, expected: ID, reason: "upper hex" },
    { input: `0X${ID}`, expected: ID, reason: "capital prefix" },
    { input: `0x${ID.slice(0, 63)}`, expected: null, reason: "short" },
    { input: `0x${ID}00`, expected: null, reason: "long" },
    { input: `0x0x${ID}`, expected: null, reason: "double prefix" },
    { input: `0x${"zz" + ID.slice(2)}`, expected: null, reason: "non-hex" },
    { input: ` 0x${ID}`, expected: null, reason: "whitespace" },
    { input: `0x${ID} `, expected: null, reason: "trailing space" },
    { input: "", expected: null, reason: "empty" },
    { input: "0x", expected: null, reason: "prefix only" },
  ],
  owner: [
    { input: `0x${OWNER}`, expected: OWNER, reason: "sdk-native" },
    { input: OWNER, expected: OWNER, reason: "canonical" },
    {
      input: "0xCb234C6FC8aBE3Eb38e31eEc6288B431E313d9b9",
      expected: OWNER,
      reason: "checksummed case",
    },
    { input: `0x${OWNER.slice(0, 39)}`, expected: null, reason: "short" },
    { input: `0x${OWNER}11`, expected: null, reason: "long" },
    { input: `0x0x${OWNER}`, expected: null, reason: "double prefix" },
    { input: "", expected: null, reason: "empty" },
  ],
  signature: [
    { input: `0x${SIG}`, expected: SIG, reason: "sdk-native" },
    { input: SIG, expected: SIG, reason: "canonical" },
    { input: `0x${SIG.toUpperCase()}`, expected: SIG, reason: "upper hex" },
    { input: `0x${SIG.slice(0, 128)}`, expected: null, reason: "short" },
    { input: `0x${SIG}00`, expected: null, reason: "long" },
    { input: `0x0x${SIG}`, expected: null, reason: "double prefix" },
    { input: "", expected: null, reason: "empty" },
  ],
  recoveryId: [
    { v: 27, expected: 0 },
    { v: 28, expected: 1 },
    { v: 0, expected: 0 },
    { v: 1, expected: 1 },
    { v: 2, expected: null },
    { v: 3, expected: null },
    { v: 29, expected: null },
    { v: 30, expected: null },
    { v: 255, expected: null },
  ],
});

// ---------------------------------------------------------------------------
// 4. EIP-712 voucher fixtures (TEST-ONLY fixed key; see header warning)
// ---------------------------------------------------------------------------
const TEST_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7b2b3f3c80";
const wallet = new ethers.Wallet(TEST_KEY);
const domain = {
  name: "OmniBounty",
  version: "1",
  chainId: 84532,
  verifyingContract: "0x1111111111111111111111111111111111111111",
};
const types = {
  Voucher: [
    { name: "bountyId", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "escrow", type: "address" },
  ],
};
const VOUCHER_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "Voucher(uint256 bountyId,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow)"
  )
);
const DOMAIN_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  )
);
const domainSeparator = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      DOMAIN_TYPEHASH,
      ethers.keccak256(ethers.toUtf8Bytes(domain.name)),
      ethers.keccak256(ethers.toUtf8Bytes(domain.version)),
      domain.chainId,
      domain.verifyingContract,
    ]
  )
);

const voucherInputs = [
  {
    name: "standard",
    bountyId: 7,
    recipient: "0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "2500000000",
    nonce: 1,
    expiry: 1893456000,
    chainId: 84532,
    escrow: domain.verifyingContract,
  },
  {
    name: "second_nonce",
    bountyId: 7,
    recipient: "0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "2500000000",
    nonce: 2,
    expiry: 1893456000,
    chainId: 84532,
    escrow: domain.verifyingContract,
  },
  {
    name: "max_amount",
    bountyId: 1,
    recipient: "0x000000000000000000000000000000000000dEaD",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: ethers.MaxUint256.toString(),
    nonce: 0,
    expiry: 1893456000,
    chainId: 84532,
    escrow: domain.verifyingContract,
  },
];

const vouchers = [];
for (const v of voucherInputs) {
  const { name, ...value } = v;
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "uint256",
        "address",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "address",
      ],
      [
        VOUCHER_TYPEHASH,
        value.bountyId,
        value.recipient,
        value.token,
        value.amount,
        value.nonce,
        value.expiry,
        value.chainId,
        value.escrow,
      ]
    )
  );
  const digest = ethers.keccak256(
    ethers.concat(["0x1901", domainSeparator, structHash])
  );
  const sig = wallet.signingKey.sign(digest);
  const recovered = ethers.recoverAddress(digest, sig).toLowerCase();
  if (recovered !== wallet.address.toLowerCase()) {
    throw new Error("oracle self-check failed on voucher recovery");
  }
  vouchers.push({
    name,
    value,
    structHash,
    digest,
    signature: { v: sig.v, r: sig.r, s: sig.s },
    signer: wallet.address.toLowerCase(),
  });
}
out("eip712.json", {
  _comment:
    "EIP-712 fixtures. Fixed test-only key; never used outside tests.",
  domain,
  voucherTypehash: VOUCHER_TYPEHASH,
  domainSeparator,
  vouchers,
});

// ---------------------------------------------------------------------------
// 5. Synthetic end-to-end claim fixture (TEST-ONLY keys: the fixed key from
//    section 4 as mock witness, keccak("omnibounty-e2e-mock-mpc-key-v1") as
//    mock-MPC). A fully compliant merged-PR proof with a
//    REAL ECDSA witness signature, plus a mock MPC response over the exact
//    voucher digest the NEAR contract must derive. Lets Rust tests run the
//    entire claim pipeline with independently generated signatures.
const WITNESS_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7b2b3f3c80";
const MPC_KEY = ethers.keccak256(
  ethers.toUtf8Bytes("omnibounty-e2e-mock-mpc-key-v1")
);
const witnessWallet = new ethers.Wallet(WITNESS_KEY);
const mpcWallet = new ethers.Wallet(MPC_KEY);

const claimParams = canonicalize({
  body: "",
  headers: { "User-Agent": "omnibounty-e2e" },
  method: "GET",
  responseMatches: [
    { type: "regex", value: '"merged":(?<merged>.*?)[,}]' },
    { type: "regex", value: '"login":"(?<author>.*?)"' },
    { type: "regex", value: '"full_name":"(?<repo>.*?)"' },
    { type: "regex", value: '"number":(?<number>.*?)[,}]' },
  ],
  responseRedactions: [],
  url: "https://api.github.com/repos/octocat/Hello-World/pulls/7",
});
const claimCtx = canonicalize({
  extractedParameters: {
    merged: "true",
    author: "octocat",
    repo: "octocat/Hello-World",
    number: "7",
  },
  providerHash:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
const claimOwner = "0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9";
const claimTs = 1794129286;
const claimEpoch = 1;
const claimId = identifierOf("http", claimParams, claimCtx);
const claimSignData = signDataOf(claimId, claimOwner, claimTs, claimEpoch);
const claimSig = await witnessWallet.signMessage(claimSignData);
const claimRecovered = ethers
  .verifyMessage(claimSignData, claimSig)
  .toLowerCase();
if (claimRecovered !== witnessWallet.address.toLowerCase()) {
  throw new Error("oracle self-check failed on synthetic claim");
}

// Voucher the NEAR contract must derive for this claim under the pinned
// test config below (nonce 0 = first claim, expiry = blockTs + ttl).
const e2eConfig = {
  chainId: 84532,
  escrow: "0x1111111111111111111111111111111111111111",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  bountyId: 7,
  amount: "2500000000",
  nonce: 0,
  blockTimestamp: claimTs + 100,
  voucherTtlSec: 86400,
  bountyExpiry: 0,
};
const e2eVoucher = {
  bountyId: e2eConfig.bountyId,
  recipient: claimOwner,
  token: e2eConfig.token,
  amount: e2eConfig.amount,
  nonce: e2eConfig.nonce,
  expiry: e2eConfig.blockTimestamp + e2eConfig.voucherTtlSec,
  chainId: e2eConfig.chainId,
  escrow: e2eConfig.escrow,
};
const e2eDomain = {
  name: "OmniBounty",
  version: "1",
  chainId: e2eConfig.chainId,
  verifyingContract: e2eConfig.escrow,
};
const e2eStructHash = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "bytes32",
      "uint256",
      "address",
      "address",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "address",
    ],
    [
      VOUCHER_TYPEHASH,
      e2eVoucher.bountyId,
      e2eVoucher.recipient,
      e2eVoucher.token,
      e2eVoucher.amount,
      e2eVoucher.nonce,
      e2eVoucher.expiry,
      e2eVoucher.chainId,
      e2eVoucher.escrow,
    ]
  )
);
const e2eDomainSep = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      DOMAIN_TYPEHASH,
      ethers.keccak256(ethers.toUtf8Bytes("OmniBounty")),
      ethers.keccak256(ethers.toUtf8Bytes("1")),
      e2eDomain.chainId,
      e2eDomain.verifyingContract,
    ]
  )
);
const e2eDigest = ethers.keccak256(
  ethers.concat(["0x1901", e2eDomainSep, e2eStructHash])
);
// Mock-MPC signs the RAW digest (Chain Signatures signs the prehash).
const mpcSig = mpcWallet.signingKey.sign(e2eDigest);
if (
  ethers.recoverAddress(e2eDigest, mpcSig).toLowerCase() !==
  mpcWallet.address.toLowerCase()
) {
  throw new Error("oracle self-check failed on mock MPC signature");
}
// MPC response shape: EXACT v3.18.0 `SignatureResponse::Secp256k1` envelope
// (scheme tag + COMPRESSED R point + scalar s + recovery id), verified
// against the deployed v1.signer-prod.testnet (see tools/probe_mpc.py).
// R's x is the signature r; y is re-derived here only as a generation-time
// sanity check (y^2 = x^3 + 7 mod p, parity = recovery bit) and is NOT
// transmitted, exactly like the real contract.
const SECP_P = 2n ** 256n - 2n ** 32n - 977n;
function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const rx = BigInt(mpcSig.r);
const mpcParity = mpcSig.v === 28 ? 1 : 0;
let ry = modPow((rx ** 3n + 7n) % SECP_P, (SECP_P + 1n) / 4n, SECP_P);
if ((ry & 1n) !== BigInt(mpcParity)) ry = SECP_P - ry;
if ((ry * ry) % SECP_P !== (rx ** 3n + 7n) % SECP_P) {
  throw new Error("R-point derivation failed");
}
const mpcPoint =
  (mpcParity === 1 ? "03" : "02") + rx.toString(16).padStart(64, "0");
out("e2e_claim.json", {
  _comment:
    "End-to-end claim fixture. Fixed test-only keys; never used outside tests.",
  proof: {
    claimInfo: {
      provider: "http",
      parameters: claimParams,
      context: claimCtx,
    },
    signedClaim: {
      claim: {
        identifier: claimId,
        owner: claimOwner,
        epoch: claimEpoch,
        timestampS: claimTs,
      },
      signatures: [claimSig],
    },
  },
  witness: witnessWallet.address.toLowerCase(),
  config: e2eConfig,
  voucher: e2eVoucher,
  structHash: e2eStructHash,
  digest: e2eDigest,
  mpcSigner: mpcWallet.address.toLowerCase(),
  mpcResponse: {
    scheme: "Secp256k1",
    big_r: { affine_point: mpcPoint.toLowerCase() },
    s: { scalar: mpcSig.s.toLowerCase().replace(/^0x/, "") },
    recovery_id: mpcParity,
  },
});

console.log("fixtures written to", root);
