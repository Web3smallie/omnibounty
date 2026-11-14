"use client";

import { useEffect, useState } from "react";
import { LoadingDots } from "./ui";
import { shortenAddress } from "../lib/display.mjs";

type CriteriaResult =
  | { ok: true; text: string; hash: string; doc: Record<string, unknown> }
  | { ok: false; reason: string; detail?: string };

const REASON_COPY: Record<string, string> = {
  missing: "No published criteria file matches this bounty.",
  unavailable: "Criteria lookup failed.",
  malformed: "Criteria is not valid JSON.",
  invalid: "Criteria failed schema validation.",
  mismatch: "Criteria does not match the on-chain hash.",
};

function reasonText(r: Extract<CriteriaResult, { ok: false }>): string {
  const base = REASON_COPY[r.reason] ?? "Criteria was rejected.";
  return r.detail ? `${base} ${r.detail}` : base;
}

function CriteriaSummary({ doc }: { doc: Record<string, unknown> }) {
  const slots = Array.isArray(doc.slots) ? doc.slots.length : null;
  return (
    <dl className="facts">
      {typeof doc.title === "string" ? (
        <>
          <dt>Title</dt>
          <dd>{doc.title}</dd>
        </>
      ) : null}
      {typeof doc.repo === "string" ? (
        <>
          <dt>Repo</dt>
          <dd className="mono">{doc.repo}</dd>
        </>
      ) : null}
      {typeof doc.merge_policy === "string" ? (
        <>
          <dt>Merge policy</dt>
          <dd>{doc.merge_policy}</dd>
        </>
      ) : null}
      {typeof doc.policy === "string" ? (
        <>
          <dt>Policy</dt>
          <dd>{doc.policy}</dd>
        </>
      ) : null}
      {slots !== null ? (
        <>
          <dt>Slots</dt>
          <dd>{slots}</dd>
        </>
      ) : null}
    </dl>
  );
}

/// V3 criteria retrieval: the contract stores only the criteria_hash, so
/// the full document must come from off-chain and be verified before use.
/// Tries the served criteria artifact first, otherwise (or additionally)
/// verifies claimant-pasted JSON. Reports verified text (or null) upward;
/// nothing unverified is ever attached to the claim.
export default function CriteriaPanel({
  bountyId,
  criteriaHash,
  onVerified,
}: {
  bountyId: number;
  criteriaHash: string;
  onVerified: (text: string | null) => void;
}) {
  const [auto, setAuto] = useState<CriteriaResult | null>(null);
  const [pasted, setPasted] = useState("");
  const [pastedBusy, setPastedBusy] = useState(false);
  const [pastedResult, setPastedResult] = useState<CriteriaResult | null>(null);

  useEffect(() => {
    let live = true;
    setAuto(null);
    setPastedResult(null);
    import("../lib/criteriaSource.mjs")
      .then(async ({ fetchCriteriaDocument }) => {
        const r = (await fetchCriteriaDocument(criteriaHash)) as CriteriaResult;
        if (live) setAuto(r);
      })
      .catch((e: unknown) => {
        if (live) {
          setAuto({
            ok: false,
            reason: "unavailable",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [bountyId, criteriaHash]);

  const verified = auto && auto.ok ? auto : pastedResult && pastedResult.ok ? pastedResult : null;
  useEffect(() => {
    onVerified(verified ? verified.text : null);
  }, [verified, onVerified]);

  async function verifyPasted() {
    setPastedBusy(true);
    try {
      const { verifyCriteriaText } = await import("../lib/criteriaSource.mjs");
      setPastedResult(verifyCriteriaText(pasted, criteriaHash) as CriteriaResult);
    } catch (e: unknown) {
      setPastedResult({
        ok: false,
        reason: "malformed",
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPastedBusy(false);
    }
  }

  return (
    <div className="card criteria-panel">
      <h3>Bounty criteria</h3>
      <p className="muted small">
        The contract commits to criteria hash <code className="mono">{shortenAddress(criteriaHash)}</code>;
        the full document below is verified against it before your claim can use it.
      </p>
      {auto === null ? (
        <LoadingDots label="Looking for the bounty criteria…" />
      ) : auto.ok ? (
        <>
          <div className="notice ok" role="status">
            Criteria verified against the on-chain hash. It will be attached to your claim
            automatically — your bundle only needs the proofs.
          </div>
          <CriteriaSummary doc={auto.doc} />
        </>
      ) : (
        <>
          <div
            className={auto.reason === "missing" ? "notice warn" : "notice error"}
            role={auto.reason === "missing" ? "status" : "alert"}
          >
            {reasonText(auto)}{" "}
            {auto.reason === "missing"
              ? "Paste the sponsor's criteria JSON to verify it instead."
              : "You can still paste the sponsor's criteria JSON to verify it instead."}
          </div>
          <label className="field">
            Criteria JSON
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder='{"schema": "omnibounty/criteria", …}'
              spellCheck={false}
              aria-invalid={pastedResult !== null && !pastedResult.ok}
              aria-describedby={pastedResult !== null && !pastedResult.ok ? "criteria-paste-error" : undefined}
            />
          </label>
          {pastedResult && !pastedResult.ok ? (
            <div className="notice error" id="criteria-paste-error" role="alert">
              {reasonText(pastedResult)}
            </div>
          ) : null}
          {pastedResult && pastedResult.ok ? (
            <>
              <div className="notice ok" role="status">
                Pasted criteria verified against the on-chain hash. It will be attached to your
                claim automatically.
              </div>
              <CriteriaSummary doc={pastedResult.doc} />
            </>
          ) : null}
          <div className="row">
            <button type="button" onClick={() => void verifyPasted()} disabled={pastedBusy || pasted.trim() === ""}>
              {pastedBusy ? "Verifying…" : "Verify pasted criteria"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
