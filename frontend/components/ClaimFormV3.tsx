"use client";

import { useEffect, useRef, useState } from "react";
import { buildQualifyArgs, mergeVerifiedCriteria, planClaimSubmission, submitWithPreflight } from "../lib/settlement.mjs";
import { createBusyGuard, createSubmitGuard } from "../lib/submitGuard.mjs";
import { EVIDENCE } from "../lib/reclaim.mjs";
import { QUALIFY_DEPOSIT_YOCTO, QUALIFY_GAS, dryQualifyV3, getClaimByPr, getSelector, signAndSend } from "../lib/near";
import { config } from "../lib/config";
import { useWallets } from "./wallets";
import { ExtLink, LoadingDots } from "./ui";
import CriteriaPanel from "./CriteriaPanel";
import ClaimPrepWizard from "./ClaimPrepWizard";
import SettlementPanel from "./SettlementPanel";
import ErrorBoundary from "./ErrorBoundary";
import { nearTxUrl, shortenAddress } from "../lib/display.mjs";
import { shouldShowNearInitError } from "../lib/walletInit.mjs";

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
/// Finalization is automatic (matured claims are picked up for the
/// permissionless `finalize_claim` without claimant action), so the
/// claimant never takes a second action: after qualification this hands
/// off to the settlement tracker below.
export default function ClaimFormV3({
  bountyId,
  slots,
  bountyExpired,
  criteriaHash,
}: {
  bountyId: number;
  slots: string[];
  bountyExpired: boolean;
  criteriaHash: string;
}) {
  const { nearAccount, connectNear, nearStatus, nearError, retryNear } = useWallets();
  const [bundleText, setBundleText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [facts, setFacts] = useState<ProofFacts | null>(null);
  const [bundle, setBundle] = useState<ParsedBundle | null>(null);
  const [busyClaim, setBusyClaim] = useState(false);
  const [claimTx, setClaimTx] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [failedTx, setFailedTx] = useState<string | null>(null);
  const [verifiedCriteria, setVerifiedCriteria] = useState<string | null>(null);
  const [alreadyPr, setAlreadyPr] = useState<number | null>(null);
  const busyClaimRef = useRef(createBusyGuard());
  const mountedRef = useRef(true);
  const liveWallets = useRef({ nearAccount });
  liveWallets.current.nearAccount = nearAccount;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function analyze(): { bundle: ParsedBundle; facts: ProofFacts } | null {
    setErrors([]);
    setFacts(null);
    setBundle(null);
    const planned = planClaimSubmission(
      mergeVerifiedCriteria(bundleText, verifiedCriteria),
      recipient || null
    );
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
    if (!busyClaimRef.current.tryAcquire()) return; // double-click: a submission is already running
    const guard = createSubmitGuard({ bountyId, nearAccount });
    // One builder, one args object: the wallet transaction sends exactly
    // what the read-only preflight just approved — no drift between them.
    const args = buildQualifyArgs(bountyId, a.bundle, recipient.trim());
    setBusyClaim(true);
    setFailedTx(null);
    try {
      // Lost-receipt recovery: if this PR already has a claim slot (a
      // previous submission landed), track it instead of resubmitting. A
      // failing read fails open — the contract still rejects duplicates.
      try {
        const existingSlot = await getClaimByPr(bountyId, Number(a.facts.number));
        if (typeof existingSlot === "number") {
          if (mountedRef.current) setAlreadyPr(Number(a.facts.number));
          return;
        }
      } catch {
        // Proceed: the pre-submit check is best-effort only.
      }
      const selector = await getSelector();
      if (!mountedRef.current) return;
      const submitted = await submitWithPreflight({
        args,
        dryCall: (q) => dryQualifyV3(q.bounty_id, q.criteria_json, q.proofs, q.recipient),
        signCall: (q) => {
          guard.assertUnchanged({ bountyId, nearAccount: liveWallets.current.nearAccount });
          return signAndSend(selector, "qualify_claim", q, QUALIFY_DEPOSIT_YOCTO, QUALIFY_GAS);
        },
      });
      if (!mountedRef.current) return;
      if (!submitted.ok) {
        setErrors(submitted.errors ?? ["Claim rejected."]);
        setFailedTx(submitted.txHash ?? null);
        return;
      }
      setClaimTx(submitted.receipt.txHash);
      setClaimed(true);
    } catch (e) {
      if (!mountedRef.current) return;
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      busyClaimRef.current.release();
      if (mountedRef.current) setBusyClaim(false);
    }
  }

  if (claimed && facts) {
    return (
      <div>
        <div className="notice ok" role="status">
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
            No further action needed — matured claims are finalized automatically, then
            settled on Base.
          </p>
        </div>
        <ErrorBoundary label="settlement tracker" resetKey={`settlement:${bountyId}`}>
          <SettlementPanel
            key={bountyId}
            bountyId={bountyId}
            initialVoucher={null}
            watch={true}
            v3={{ slots, recipient: recipient.trim(), prNumber: Number(facts.number) }}
          />
        </ErrorBoundary>
      </div>
    );
  }

  if (alreadyPr !== null) {
    return (
      <div>
        <div className="notice warn" role="status">
          <strong>A claim for PR #{alreadyPr} is already on NEAR.</strong>{" "}
          <span className="muted small">
            A previous submission landed — track its qualification and settlement below instead of
            submitting again.
          </span>
        </div>
        <ErrorBoundary label="settlement tracker" resetKey={`settlement:${bountyId}`}>
          <SettlementPanel
            key={bountyId}
            bountyId={bountyId}
            initialVoucher={null}
            watch={true}
            v3={{ slots, recipient: recipient.trim(), prNumber: alreadyPr }}
          />
        </ErrorBoundary>
      </div>
    );
  }

  return (
    <div className="claim-flow">
      {bountyExpired && (
        <div className="notice error" role="alert">
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
          Get <code>criteria_json</code> from the criteria panel below (verified against the
          on-chain hash) or paste the sponsor&apos;s document there for verification. Generate
          the proofs with <code>scripts/prove.mjs</code> and{" "}
          <code>scripts/prove_identity.mjs</code> on your own machine (see{" "}
          <code>frontend/README.md</code>); the app secret and your GitHub token stay on your
          machine and never enter this page. Qualification costs 1 NEAR storage deposit plus
          gas from your NEAR wallet.
        </p>
      </details>

      <CriteriaPanel bountyId={bountyId} criteriaHash={criteriaHash} onVerified={setVerifiedCriteria} />

      <ClaimPrepWizard
        verifiedCriteria={verifiedCriteria}
        onBundleReady={(text, owner) => {
          setBundleText(text);
          setRecipient(owner);
        }}
      />

      <details className="help">
        <summary>Advanced: paste a full bundle manually</summary>
        <label className="field">
          Claim bundle JSON
          {verifiedCriteria ? (
            <span className="hint">
              Verified criteria will be attached automatically — your bundle only needs{" "}
              <code>proofs</code>.
            </span>
          ) : null}
          <textarea
            value={bundleText}
            onChange={(e) => setBundleText(e.target.value)}
            placeholder='{"criteria_json": …, "proofs": [{"tag": "pr", "proof": …}]}'
            spellCheck={false}
            aria-invalid={errors.length > 0}
            aria-describedby={errors.length > 0 ? "claim-errors" : undefined}
          />
        </label>
      </details>
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
            aria-invalid={errors.length > 0}
            aria-describedby={errors.length > 0 ? "claim-errors" : undefined}
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
        <ul className="errors" id="claim-errors" role="alert">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {failedTx && (
        <p className="muted small">
          Failed transaction:{" "}
          <ExtLink href={nearTxUrl(config.networkId, failedTx)}>
            <code>{shortenAddress(failedTx)} ↗</code>
          </ExtLink>
        </p>
      )}
      {shouldShowNearInitError(nearStatus, nearAccount) && (
        <div className="notice error" role="alert">
          NEAR wallet setup failed: {nearError}{" "}
          <button type="button" onClick={retryNear}>
            Retry setup
          </button>
        </div>
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
