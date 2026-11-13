// EXP-07: negative controls through the REAL dry_run view (read-only).
// (a) Bounty mismatch: fresh react#38132 proof (exp01c fixture) vs bounty #1
//     (react#1) → expect template number-mismatch panic (NOT OK).
// (b) Tamper evidence: flip one extracted char in a COPY → expect identifier
//     or signature failure (NOT OK). Proves proofs can't be edited.
// (c) Stale evidence: historical spike proof (testdata/reclaim.json) → expect
//     ProofTooOld if its timestamp predates the 7d window.
// Zero new attestations. Zero state changes (views only).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, nearView } from './lib/exp-common.mjs';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { validateProofShape } = await import(pathToFileURL(join(ROOT, 'frontend', 'lib', 'validation.mjs')).href);

async function dryRun(bountyId, proof, recipient) {
  try {
    const out = await nearView('dry_run', { bounty_id: bountyId, proof, recipient });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: String(e.message).slice(0, 260) };
  }
}
const toOnchain = (zkProof) => {
  const s = validateProofShape(zkProof);
  if (!s.ok) throw new Error('shape: ' + s.errors.join(';'));
  return s.normalized;
};

// (a) mismatch: newest exp01c fixture vs bounty #1.
const { readdirSync } = await import('node:fs');
const cands = readdirSync(join(HERE, '..', 'fixtures')).filter((f) => f.startsWith('exp01c-')).sort();
const fresh = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', cands[cands.length - 1]), 'utf8'));
const rA = await dryRun(1, toOnchain(fresh), fresh.claimData.owner);
console.log('[A] fresh #38132 proof vs bounty #1 (react#1):', rA.ok ? `UNEXPECTED OK: ${rA.out}` : `rejected as required: ${/NUMBER|number|mismatch/i.test(rA.err) ? 'number-mismatch-class' : rA.err}`);

// (b) tamper: flip merged true->false in a COPY (breaks identifier/signature binding).
const tamp = JSON.parse(JSON.stringify(fresh));
const ctx = JSON.parse(tamp.claimData.context);
ctx.extractedParameters.merged = ctx.extractedParameters.merged === 'true' ? 'false' : 'true';
tamp.claimData.context = JSON.stringify(ctx);
const rB = await dryRun(4, toOnchain(tamp), tamp.claimData.owner);
console.log('[B] tampered copy vs bounty #4:', rB.ok ? `UNEXPECTED OK: ${rB.out}` : `rejected as required: ${/IDENTIFIER|RECOVER|SIGNATURE|identifier|recover/i.test(rB.err) ? 'binding-failure-class' : rB.err}`);

// (c) stale: historical spike proof vs bounty #1.
const reclaim = JSON.parse(readFileSync(join(ROOT, 'testdata', 'reclaim.json'), 'utf8'));
const spike = reclaim.spike;
console.log(`[C] spike timestampS=${spike.claim.timestampS} (age ${((Date.now() / 1000 - spike.claim.timestampS) / 86400).toFixed(1)}d)`);
const spikeProof = { claimInfo: spike.claimInfo, signedClaim: { claim: spike.claim, signatures: spike.signatures } };
const rC = await dryRun(1, spikeProof, spike.claim.owner);
console.log('[C] spike proof vs bounty #1:', rC.ok ? `UNEXPECTED OK: ${rC.out}` : `rejected as required: ${/TOO_OLD|too old|ProofTooOld/i.test(rC.err) ? 'staleness-class' : rC.err}`);

const pass = !rA.ok && !rB.ok && !rC.ok;
console.log('EXP-07', pass ? 'COMPLETE PASS (all three negatives rejected)' : 'COMPLETE WITH FAILURES');
process.exit(pass ? 0 : 1);
