"use client";

import { useState } from "react";
import { extractProofFacts, validateProofShape } from "../lib/validation.mjs";
import { dryRun, getSelector, signAndSend } from "../lib/near";
import type { SignedVoucherView } from "../lib/near";
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

export default function ClaimForm({
  bountyId,
  bountyRepo,
  bountyPrNumber,
  bountyExpired,
}: {
  bountyId: number;
  bountyRepo: string;
  bountyPrNumber: number;
  bountyExpired: boolean;
}) {
  const { nearAccount, connectNear } = useWallets();
  const [proofText, setProofText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [facts, setFacts] = useState<ProofFacts | null>(null);
  const [normalized, setNormalized] = useState<unknown>(null);
  const [dryResult, setDryResult] = useState<string | null>(null);
  const [dryError, setDryError] = useState<string | null>(null);
  const [busyDry, setBusyDry] = useState(false);
  const [busyClaim, setBusyClaim] = useState(false);
  const [claimTx, setClaimTx] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  function analyze(): { proof: unknown; facts: ProofFacts } | null {
    setErrors([]);
    setDryResult(null);
    setDryError(null);
    setFacts(null);
    setNormalized(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(proofText);
    } catch {
      setErrors(["Proof is not valid JSON. Paste the exact output of the prove script."]);
      return null;
    }
    const shape = validateProofShape(parsed);
    if (!shape.ok) {
      setErrors(shape.errors);
      return null;
    }
    const f = extractProofFacts(shape.normalized);
    if (!f.ok) {
      setErrors(f.errors);
      return null;
    }
    const owner = (shape.normalized as { signedClaim: { claim: { owner: string } } }).signedClaim.claim.owner;
    const facts = { ...f.facts, owner } as ProofFacts;
    setFacts(facts);
    setNormalized(shape.normalized);
    if (!recipient) setRecipient(owner);
    const problems: string[] = [];
    if (facts.merged !== "true") problems.push("This proof says the PR is NOT merged (merged=false) — the contract will reject it.");
    if (facts.repo !== bountyRepo || facts.number !== String(bountyPrNumber)) {
      problems.push(
        `This proof is for ${facts.repo}#${facts.number}, but the bounty needs ${bountyRepo}#${bountyPrNumber} — the contract will reject it.`
      );
    }
    if (problems.length > 0) setErrors(problems);
    return { proof: shape.normalized, facts };
  }

  async function runDry() {
    const a = analyze();
    if (!a) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.trim())) {
      setErrors(["Recipient must be a 0x-prefixed EVM address matching the proof owner."]);
      return;
    }
    setBusyDry(true);
    try {
      const out = await dryRun(bountyId, a.proof, recipient.trim());
      setDryResult(out);
    } catch (e) {
      setDryError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyDry(false);
    }
  }

  async function runClaim() {
    setErrors([]);
    setDryError(null);
    if (!normalized || !facts) {
      setErrors(["Analyze a valid proof first."]);
      return;
    }
    if (recipient.trim().toLowerCase() !== facts.owner.toLowerCase()) {
      setErrors(["Recipient must exactly equal the proof owner — the payout can only go to the prover."]);
      return;
    }
    if (!nearAccount) {
      setErrors(["Connect your NEAR wallet first — the claim is submitted from that account."]);
      return;
    }
    setBusyClaim(true);
    try {
      const selector = await getSelector();
      const receipt = await signAndSend(selector, "claim", {
        bounty_id: bountyId,
        proof: normalized,
        recipient: recipient.trim(),
      });
      setClaimTx(receipt.txHash);
      setClaimed(true);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusyClaim(false);
    }
  }

  if (claimed) {
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
        </div>
        <SettlementPanel bountyId={bountyId} initialVoucher={null} watch={true} />
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
        <summary>How do I get a proof?</summary>
        <p>
          Proofs are generated off-chain with the repository&apos;s prove script, which fetches the
          PR over Reclaim zkTLS and extracts the merge facts the contract checks:
        </p>
        <pre className="mono small">
          RECLAIM_APP_ID=0x… RECLAIM_APP_SECRET=0x…{"\n"}npm run prove -- {bountyRepo} {bountyPrNumber} ./proof.json
        </pre>
        <p className="muted small">
          See <code>frontend/README.md</code> for setup. The app secret stays on your machine —
          only the proof JSON is pasted below. Both zk-fetch and on-chain proof shapes are
          accepted.
        </p>
      </details>

      <label className="field">
        Reclaim proof JSON
        <textarea
          value={proofText}
          onChange={(e) => setProofText(e.target.value)}
          placeholder='{"claimData": …} or {"claimInfo": …}'
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
        <button onClick={() => void runDry()} disabled={busyDry || busyClaim || bountyExpired}>
          {busyDry ? "Checking…" : "1 · Dry-run against contract"}
        </button>
        {!nearAccount ? (
          <button className="primary" onClick={connectNear}>
            Connect NEAR to claim
          </button>
        ) : (
          <button className="primary" onClick={() => void runClaim()} disabled={busyClaim || busyDry || bountyExpired}>
            {busyClaim ? "Submitting…" : "2 · Submit claim"}
          </button>
        )}
      </div>
      {(busyDry || busyClaim) && (
        <div className="notice">
          <LoadingDots label={busyDry ? "Running contract dry-run (free, read-only)" : "Submitting claim — confirm in your NEAR wallet"} />
        </div>
      )}
      {dryResult && (
        <div className="notice ok">
          Dry-run passed: <code>{dryResult}</code>
        </div>
      )}
      {dryError && (
        <div className="notice error">
          Dry-run failed: <code>{dryError}</code>
          <p className="muted small">
            The contract would reject this claim. Common causes: wrong PR, unmerged PR, stale
            proof, or a recipient that does not match the proof owner.
          </p>
        </div>
      )}
    </div>
  );
}

export type { SignedVoucherView };
