// Oracle fixture generator: VoucherV2 EIP-712 vectors (ethers v6 reference).
// Writes testdata/v3/eip712-voucher2.json: typeHash + per-vector
// domainSeparator/structHash/digest for grounded inputs. Pure offline hashing.
// Usage: node tools/gen_v3_fixtures.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { ethers } = require(join(ROOT, 'frontend', 'node_modules', 'ethers'));

const TYPE_STRING =
  'VoucherV2(uint256 bountyId,uint8 slotIndex,address recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow,bytes32 criteriaHash)';
const TYPES = {
  VoucherV2: [
    { name: 'bountyId', type: 'uint256' },
    { name: 'slotIndex', type: 'uint8' },
    { name: 'recipient', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'chainId', type: 'uint256' },
    { name: 'escrow', type: 'address' },
    { name: 'criteriaHash', type: 'bytes32' },
  ],
};

// Grounded inputs: e2e owner + real USDC + simple-ci golden criteria hash +
// weighted slot amounts; escrow is the repo placeholder (V3 undeployed).
const VECTORS = [
  {
    tag: 'slot2-weighted-first',
    bountyId: 7,
    slotIndex: 2,
    recipient: '0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9',
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: '60000000',
    nonce: 1,
    expiry: 1794507005,
    chainId: 84532,
    escrow: '0x1111111111111111111111111111111111111111',
    criteriaHash: '0x499dcdccb8acfafe8d71e42ac91ab86cacbac30bf2b33c521b1bd47a31641d10',
  },
  {
    tag: 'slot0-single-zero-nonce',
    bountyId: 1,
    slotIndex: 0,
    recipient: '0x0000000000000000000000000000000000000001',
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: '1000000',
    nonce: 0,
    expiry: 1794424969,
    chainId: 84532,
    escrow: '0x1111111111111111111111111111111111111111',
    criteriaHash: '0xa08efc663519ac022a0b78ee2a38fcdf5eab35c2e48ef3a8e6c020aca38714e0',
  },
];

const out = {
  _comment: 'V2-independent VoucherV2 oracle vectors (ethers v6). Do not hand-edit; regenerate with tools/gen_v3_fixtures.mjs.',
  typeString: TYPE_STRING,
  typeHash: ethers.id(TYPE_STRING),
  vectors: VECTORS.map((v) => {
    const { tag, chainId, escrow, ...rest } = v;
    const domain = { name: 'OmniBounty', version: '1', chainId, verifyingContract: escrow };
    return {
      tag,
      ...v,
      domainSeparator: ethers.TypedDataEncoder.hashDomain(domain),
      structHash: ethers.TypedDataEncoder.hashStruct('VoucherV2', TYPES, { ...rest, chainId, escrow }),
      digest: ethers.TypedDataEncoder.hash(domain, TYPES, { ...rest, chainId, escrow }),
    };
  }),
};
writeFileSync(join(ROOT, 'testdata', 'v3', 'eip712-voucher2.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote eip712-voucher2.json (${out.vectors.length} vectors) typeHash=${out.typeHash}`);
process.exit(0);
