"use client";

import { useMemo, useState } from "react";
import {
  ENV_LOCAL_TEMPLATE,
  assembleClaimBundle,
  buildProveCommand,
  checkWizardBinding,
  parsePrUrl,
  splitPastedProofs,
  validatePastedIdentityProof,
  validatePastedPrProof,
} from "../lib/claimPrep.mjs";
import { ExtLink } from "./ui";
import { shortenAddress } from "../lib/display.mjs";

type SlotState =
  | { status: "empty" }
  | { status: "ok"; text: string; facts: Record<string, string>; proof: object }
  | { status: "error"; errors: string[] };

type ValidatedSlot = Extract<SlotState, { status: "ok" }>;

/// Guided claim preparation: explains the two genuine Reclaim
/// attestations every claim needs, validates pasted proofs immediately
/// with the same checkers the contract enforces, and assembles the
/// claim bundle automatically. Secrets never enter this page — proofs
/// are minted on the contributor's own machine with one local command.
/// Calls onBundleReady(bundleText, owner) once everything validates.
export default function ClaimPrepWizard({
  verifiedCriteria,
  onBundleReady,
}: {
  verifiedCriteria: string | null;
  onBundleReady: (bundleText: string, recipient: string) => void;
}) {
  const [prUrl, setPrUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [prSlot, setPrSlot] = useState<SlotState>({ status: "empty" });
  const [idSlot, setIdSlot] = useState<SlotState>({ status: "empty" });
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  const [assembleErrors, setAssembleErrors] = useState<string[]>([]);
  const [applied, setApplied] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedEnv, setCopiedEnv] = useState(false);

  const parsed = useMemo(() => parsePrUrl(prUrl), [prUrl]);
  const criteriaRepo = useMemo(() => {
    if (!verifiedCriteria) return null;
    try {
      const repo = (JSON.parse(verifiedCriteria) as { repo?: unknown }).repo;
      return typeof repo === "string" && repo.length > 0 ? repo : null;
    } catch {
      return null;
    }
  }, [verifiedCriteria]);
  // The bounty criteria name the authoritative repository; until they
  // resolve, the contributor's own PR link is the expectation.
  const expectedRepo = criteriaRepo ?? (parsed.ok ? parsed.repo : null);
  const repoConflict =
    criteriaRepo !== null && parsed.ok && parsed.repo !== criteriaRepo;

  const prNumber = parsed.ok ? parsed.prNumber : null;
  const command =
    parsed.ok && prNumber ? buildProveCommand({ repo: parsed.repo, prNumber }) : null;

  const binding = useMemo(() => {
    if (prSlot.status !== "ok" || idSlot.status !== "ok") return null;
    return checkWizardBinding({ prProof: prSlot.proof, identityProof: idSlot.proof }) as string[];
  }, [prSlot, idSlot]);

  function resetSlots() {
    setPrSlot({ status: "empty" });
    setIdSlot({ status: "empty" });
    setPasteErrors([]);
    setAssembleErrors([]);
    setApplied(false);
  }

  function validatePaste() {
    setPasteErrors([]);
    setAssembleErrors([]);
    setApplied(false);
    const split = splitPastedProofs(paste) as
      | { ok: false; errors: string[] }
      | { ok: true; kind: "bundle-output"; prText: string; identityText: string }
      | { ok: true; kind: "single"; text: string };
    if (!split.ok) {
      setPasteErrors(split.errors);
      return;
    }
    if (!parsed.ok || !prNumber || !expectedRepo) {
      setPasteErrors(["Enter your pull request link in step 1 first, so proofs can be checked against it."]);
      return;
    }
    if (split.kind === "bundle-output") {
      const pr = validatePastedPrProof(split.prText, { repo: expectedRepo, prNumber }) as {
        ok: boolean;
        errors: string[];
        proof?: object;
        facts?: Record<string, string>;
      };
      const id = validatePastedIdentityProof(split.identityText) as {
        ok: boolean;
        errors: string[];
        proof?: object;
        facts?: Record<string, string>;
      };
      setPrSlot(
        pr.ok && pr.proof && pr.facts
          ? { status: "ok", text: split.prText, facts: pr.facts, proof: pr.proof }
          : { status: "error", errors: pr.errors }
      );
      setIdSlot(
        id.ok && id.proof && id.facts
          ? { status: "ok", text: split.identityText, facts: id.facts, proof: id.proof }
          : { status: "error", errors: id.errors }
      );
      return;
    }
    // One standalone proof: it is valid for exactly one slot. Try the PR
    // slot first (most pastes), then identity; fill whichever passes.
    const asPr = validatePastedPrProof(split.text, { repo: expectedRepo, prNumber }) as {
      ok: boolean;
      errors: string[];
      proof?: object;
      facts?: Record<string, string>;
    };
    if (asPr.ok && asPr.proof && asPr.facts) {
      setPrSlot({ status: "ok", text: split.text, facts: asPr.facts, proof: asPr.proof });
      setPaste("");
      return;
    }
    const asId = validatePastedIdentityProof(split.text) as {
      ok: boolean;
      errors: string[];
      proof?: object;
      facts?: Record<string, string>;
    };
    if (asId.ok && asId.proof && asId.facts) {
      setIdSlot({ status: "ok", text: split.text, facts: asId.facts, proof: asId.proof });
      setPaste("");
      return;
    }
    setPasteErrors([
      "That paste is neither a valid PR proof nor a valid identity proof for this claim:",
      ...asPr.errors,
      ...asId.errors,
    ]);
  }

  function assemble() {
    setAssembleErrors([]);
    if (!verifiedCriteria) {
      setAssembleErrors(["The bounty criteria have not been verified yet — wait for the criteria panel above."]);
      return;
    }
    if (prSlot.status !== "ok" || idSlot.status !== "ok") {
      setAssembleErrors(["Both proofs must validate in step 2 first."]);
      return;
    }
    if (!parsed.ok || !prNumber || repoConflict) {
      setAssembleErrors(["Resolve the pull request link in step 1 first."]);
      return;
    }
    // Re-validate from the stored texts against the authoritative
    // criteria repository: nothing reaches the form unchecked.
    const pr = validatePastedPrProof(prSlot.text, { repo: expectedRepo as string, prNumber }) as {
      ok: boolean;
      errors: string[];
      proof?: object;
    };
    const id = validatePastedIdentityProof(idSlot.text) as {
      ok: boolean;
      errors: string[];
      proof?: object;
    };
    if (!pr.ok || !pr.proof) {
      setAssembleErrors(pr.errors);
      setPrSlot({ status: "error", errors: pr.errors });
      return;
    }
    if (!id.ok || !id.proof) {
      setAssembleErrors(id.errors);
      setIdSlot({ status: "error", errors: id.errors });
      return;
    }
    const problems = checkWizardBinding({ prProof: pr.proof, identityProof: id.proof }) as string[];
    if (problems.length > 0) {
      setAssembleErrors(problems);
      return;
    }
    const built = assembleClaimBundle({ criteriaJson: verifiedCriteria, prProof: pr.proof, identityProof: id.proof }) as {
      ok: boolean;
      errors: string[];
      bundleText?: string;
    };
    if (!built.ok || !built.bundleText) {
      setAssembleErrors(built.errors);
      return;
    }
    const owner = (prSlot.facts.owner ?? "") as string;
    onBundleReady(built.bundleText, owner);
    setApplied(true);
  }

  async function copy(text: string, done: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      done(true);
    } catch {
      done(false);
    }
  }

  const bothOk = prSlot.status === "ok" && idSlot.status === "ok";
  const bindingClean = binding !== null && binding.length === 0;
  const stepState = (done: boolean, bad: boolean) => (bad ? "error" : done ? "done" : "idle");

  return (
    <section className="card" id="prepare-claim" aria-label="Prepare claim">
      <h3>Prepare claim</h3>
      <p className="muted small">
        Every claim proves two things with genuine Reclaim attestations:{" "}
        <strong>your pull request is merged</strong> in the bounty repository, and{" "}
        <strong>you are the GitHub user who authored it</strong>. Both proofs are
        minted on your own machine with one command — your Reclaim app secret
        and GitHub token never leave it and never enter this page. Nothing is
        simulated: each paste below is validated immediately, and the contract
        re-checks everything before any payout.
      </p>

      <ol className="steps">
        <li className={`step step-${stepState(parsed.ok && !repoConflict, repoConflict)}`}>
          <span className="step-label">1 · Your pull request</span>
        </li>
        <li
          className={`step step-${stepState(bothOk, prSlot.status === "error" || idSlot.status === "error")}`}
        >
          <span className="step-label">2 · Proofs validated</span>
        </li>
        <li className={`step step-${stepState(applied, false)}`}>
          <span className="step-label">3 · Loaded into the claim form</span>
        </li>
      </ol>

      <label className="field">
        Your pull request link
        <span className="hint">
          The merged PR you are claiming with, e.g. https://github.com/owner/name/pull/123.
          {criteriaRepo ? ` This bounty requires the ${criteriaRepo} repository.` : ""}
        </span>
        <input
          type="text"
          value={prUrl}
          onChange={(e) => {
            setPrUrl(e.target.value);
            resetSlots();
          }}
          placeholder="https://github.com/owner/name/pull/123"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {repoConflict && (
        <div className="notice error" role="alert">
          That PR is in {parsed.ok ? parsed.repo : "another repository"} but this bounty
          requires {criteriaRepo}. Claims from other repositories are rejected on-chain.
        </div>
      )}

      {command && !repoConflict && (
        <div className="field">
          <span>Run this once on your machine</span>
          <span className="hint">
            Needs your Reclaim app ID/secret (free at{" "}
            <ExtLink href="https://dev.reclaimprotocol.org">dev.reclaimprotocol.org</ExtLink>)
            and your own GitHub token in <code>frontend/.env.local</code> — both stay
            on your machine. Writes <code>claim-proofs.json</code> with both proofs.
          </span>
          <pre className="mono small">{command}</pre>
          <div className="row">
            <button type="button" className="suggest" onClick={() => void copy(command, setCopiedCmd)}>
              {copiedCmd ? "Command copied" : "Copy command"}
            </button>
            <button
              type="button"
              className="suggest"
              onClick={() => void copy(ENV_LOCAL_TEMPLATE as string, setCopiedEnv)}
            >
              {copiedEnv ? "Template copied" : "Copy .env.local template"}
            </button>
          </div>
        </div>
      )}

      <label className="field">
        Paste the proofs
        <span className="hint">
          Paste the whole <code>claim-proofs.json</code> file at once, or paste each
          proof separately — each paste is validated on the spot.
        </span>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder='{"prProof": …, "identityProof": …}  or one proof'
          spellCheck={false}
          aria-invalid={pasteErrors.length > 0}
          aria-describedby={pasteErrors.length > 0 ? "prepare-errors" : undefined}
        />
      </label>
      <div className="row">
        <button type="button" onClick={() => validatePaste()}>
          Validate pasted proofs
        </button>
      </div>

      <dl className="facts">
        <dt>Merged-PR proof</dt>
        <dd className={prSlot.status === "ok" ? "good" : prSlot.status === "error" ? "bad" : "muted"}>
          {prSlot.status === "ok"
            ? `${prSlot.facts.repo}#${prSlot.facts.number} by ${prSlot.facts.author} — merged: ${prSlot.facts.merged}`
            : prSlot.status === "error"
              ? prSlot.errors.join("; ")
              : "waiting for a paste"}
        </dd>
        <dt>Identity proof</dt>
        <dd className={idSlot.status === "ok" ? "good" : idSlot.status === "error" ? "bad" : "muted"}>
          {idSlot.status === "ok"
            ? `${idSlot.facts.id_login} (id ${idSlot.facts.id_num})`
            : idSlot.status === "error"
              ? idSlot.errors.join("; ")
              : "waiting for a paste"}
        </dd>
        {bothOk && (
          <>
            <dt>Shared owner</dt>
            <dd className="mono small" title={(prSlot as ValidatedSlot).facts.owner}>
              {shortenAddress((prSlot as ValidatedSlot).facts.owner)}
            </dd>
          </>
        )}
      </dl>

      {bothOk && binding && binding.length > 0 && (
        <div className="notice error" role="alert">
          These two proofs do not belong together: {binding.join("; ")}
        </div>
      )}

      {pasteErrors.length > 0 && (
        <ul className="errors" id="prepare-errors" role="alert">
          {pasteErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      {!verifiedCriteria && (
        <p className="muted small" role="status">
          The bounty criteria panel above is still resolving — the bundle needs
          the verified criteria document before it can be assembled.
        </p>
      )}

      {assembleErrors.length > 0 && (
        <ul className="errors" role="alert">
          {assembleErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={() => assemble()}
          disabled={!bothOk || !bindingClean || !verifiedCriteria || repoConflict}
        >
          Use these proofs in the claim form
        </button>
      </div>
      {applied && (
        <div className="notice ok" role="status">
          Proofs loaded into the claim form below — review and press “1 · Analyze
          bundle”, then submit.
        </div>
      )}
    </section>
  );
}
