"use client";

import { useState } from "react";
import { buildQualifyArgs, planClaimSubmission, submitWithPreflight } from "../lib/settlement.mjs";
import { EVIDENCE } from "../lib/reclaim.mjs";
import { QUALIFY_DEPOSIT_YOCTO, QUALIFY_GAS, dryQualifyV3, getSelector, signAndSend } from "../lib/near";
import { config } from "../lib/config";
import { useWallets } from "./wallets";
import { ExtLink, LoadingDots } from "./ui";
import SettlementPanel from "./SettlementPanel";
import { nearTxUrl, shortenAddress } from "../lib/display.mjs";

interface ProofFacts {
  merged: string;
  author: string;
  repo: string;
  number: string;
  owner: string;
}

interface ParsedBundle {
  criteria_json: string;
  proofs: Array<{ evidence_type: number; proof: unknown }>;
}

/// V3 claim form: one bundle paste -> one `qualify_claim` wallet approval.
/// Finalization is automatic (the relayer submits permissionless
/// `finalize_claim` once the challenge window elapses), so the claimant
/// never takes a second action: after qualification this hands off to the
/// settlement tracker below.
export default function ClaimFormV3({
  bountyId,
  slots,
  bountyExpired,
}: {
  bountyId: number;
  slots: string[];
  bountyExpired: boolean;
}) {
  const { nearAccount, connectNear } = useWallets();
  const [bundleText, setBundleText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [facts, setFacts] = useState<ProofFacts | null>(null);
  const [bundle, setBundle] = useState<ParsedBundle | null>(null);
  const [busyClaim, setBusyClaim] = useState(false);
  const [claimTx, setClaimTx] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  function analyze(): { bundle: ParsedBundle; facts: ProofFacts } | null {
    setErrors([]);
    setFacts(null);
    setBundle(null);
    const planned = planClaimSubmission(bundleText, recipient || null);
    if (!planned.ok) {
      setErrors(planned.errors ?? ["Invalid claim bundle."]);
      return null;
    }
    const facts = planned.facts as ProofFacts;
    const bundle = planned.bundle as ParsedBundle;
    setFacts(facts);
    setBundle(bundle);
    if (!recipient) setRecipient(facts.owner);
    return { bundle, facts };
  }

  async function runClaim() {
    const a = analyze();
    if (!a) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.trim())) {
      setErrors(["Recipient must be a 0x-prefixed EVM address matching the proof owner."]);
      return;
    }
    if (recipient.trim().toLowerCase() !== a.facts.owner.toLowerCase()) {
      setErrors(["Recipient must exactly equal the proof owner — the payout can only go to the prover."]);
      return;
    }
    if (!nearAccount) {
      setErrors(["Connect your NEAR wallet first — the claim is submitted from that account."]);
      return;
    }
    // One builder, one args object: the wallet transaction sends exactly
    // what the read-only preflight just approved — no drift between them.
    const args = buildQualifyArgs(bountyId, a.bundle, recipient.trim());
    setBusyClaim(true);
    try {
      const selector = await getSelector();
      const submitted = await submitWithPreflight({
        args,
        dryCall: (q) => dryQualifyV3(q.bounty_id, q.criteria_json, q.proofs, q.recipient),
        signCall: (q) => signAndSend(selector, "qualify_claim", q, QUALIFY_DEPOSIT_YOCTO, QUALIFY_GAS),
      });
      if (!submitted.ok) {
        setErrors(submitted.errors ?? ["Claim rejected."]);
        return;
      }
      setClaimTx(submitted.receipt.txHash);
      setClaimed(true);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusyClaim(false);
    }
  }

  if (claimed && facts) {
    return (
      <div>
        <div className="notice ok">
          <strong>Claim submitted on NEAR.</strong>{" "}
          {claimTx ? (
            <span>
              Transaction{" "}
              <ExtLink href={nearTxUrl(config.networkId, claimTx)}>
                <code>{shortenAddress(claimTx)} ↗</code>
              </ExtLink>
            </span>
          ) : (
            <span className="muted small">(wallet did not return a transaction hash)</span>
          )}
          <p className="muted small" style={{ marginTop: 4 }}>
            No further action needed — the relayer finalizes matured claims automatically, then
            settles the signed voucher on Base.
          </p>
        </div>
        <SettlementPanel
          bountyId={bountyId}
          initialVoucher={null}
          watch={true}
          v3={{ slots, recipient: recipient.trim(), prNumber: Number(facts.number) }}
        />
      </div>
    );
  }

  return (
    <div className="claim-flow">
      {bountyExpired && (
        <div className="notice error">
          This bounty is past its deadline. The contract will reject new claims.
        </div>
      )}
      <details className="help">
        <summary>What goes in the bundle?</summary>
        <p>
          One JSON object with the bounty&apos;s criteria document and two Reclaim proofs: the
          PR evidence (<code>evidence_type: 1</code>) and your GitHub identity proof
          (<code>evidence_type: 7</code>), both generated with your own app secret so they
          share one owner:
        </p>
        <pre className="mono small">
          {`{"criteria_json": {…sponsor criteria…},\n "proofs": [{"evidence_type": 1, "proof": {…pr…}},\n           {"evidence_type": 7, "proof": {…identity…}}]}`}
        </pre>
        <p className="muted small">
          Get <code>criteria_json</code> from the sponsor listing. Generate the proofs with{" "}
          <code>scripts/prove.mjs</code> and <code>scripts/prove_identity.mjs</code> (see{" "}
          <code>frontend/README.md</code>); the app secret and your GitHub token stay on your
          machine. Qualification costs 1 NEAR storage deposit plus gas from your NEAR wallet.
        </p>
      </details>

      <label className="field">
        Claim bundle JSON
        <textarea
          value={bundleText}
          onChange={(e) => setBundleText(e.target.value)}
          placeholder='{"criteria_json": …, "proofs": [{"tag": "pr", "proof": …}]}'
          spellCheck={false}
        />
      </label>
      <label className="field">
        Payout recipient
        <span className="hint">Must equal the proof owner below — frontrunners cannot redirect funds.</span>
        <div className="field-row">
          <input
            className="grow mono"
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
          />
          {facts && (
            <button type="button" className="suggest" onClick={() => setRecipient(facts.owner)}>
              Use proof owner
            </button>
          )}
        </div>
      </label>

      {facts && (
        <dl className="facts proof-facts">
          <dt>Proof says merged</dt>
          <dd className={facts.merged === "true" ? "good" : "bad"}>{facts.merged}</dd>
          <dt>Proof PR</dt>
          <dd className="mono">
            {facts.repo}#{facts.number}
          </dd>
          <dt>Proof author</dt>
          <dd>{facts.author}</dd>
          <dt>Proof owner</dt>
          <dd className="mono small">{shortenAddress(facts.owner)}</dd>
          <dt>Bundle proofs</dt>
          <dd className="mono small">
            {bundle
              ? bundle.proofs
                  .map((p) => (p.evidence_type === EVIDENCE.Pr ? "pr" : p.evidence_type === EVIDENCE.Identity ? "identity" : `#${p.evidence_type}`))
                  .join(", ")
              : "—"}
          </dd>
        </dl>
      )}

      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="row">
        <button onClick={() => void analyze()} disabled={busyClaim || bountyExpired}>
          1 · Analyze bundle
        </button>
        {!nearAccount ? (
          <button className="primary" onClick={connectNear}>
            Connect NEAR to claim
          </button>
        ) : (
          <button className="primary" onClick={() => void runClaim()} disabled={busyClaim || bountyExpired || !bundle}>
            {busyClaim ? "Submitting…" : "2 · Submit claim"}
          </button>
        )}
      </div>
      {busyClaim && (
        <div className="notice">
          <LoadingDots label="Checking claim on-chain, then submitting — confirm in your NEAR wallet" />
        </div>
      )}
    </div>
  );
}
