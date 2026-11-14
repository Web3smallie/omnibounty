"use client";

import { useEffect, useState } from "react";
import { getSharedResolver } from "../lib/criteriaResolve.mjs";
import { config } from "../lib/config";
import { ExtLink, LoadingDots } from "./ui";
import { shortenAddress } from "../lib/display.mjs";

interface CriteriaDocLike {
  title?: unknown;
  description?: unknown;
  repo?: unknown;
  merge_policy?: unknown;
  author_association?: unknown;
  issue?: { url?: unknown; keywords?: unknown } | null;
  checks?: { required?: Array<{ name?: unknown }> } | null;
  files?: {
    allowed_paths?: unknown;
    required_touched?: unknown;
    forbidden_paths?: unknown;
    max_changed_files?: unknown;
    patch_contains_all?: unknown;
  } | null;
  labels?: { required_all?: unknown[] } | null;
  reviews?: { required_approvals?: Array<{ login?: unknown }> } | null;
}

type DetailsState =
  | { status: "loading" }
  | { status: "ready"; doc: CriteriaDocLike }
  | { status: "missing" }
  | { status: "error"; message: string };

/// Contributor-facing task description: resolves the criteria through
/// the shared universal resolver (verified cache -> served artifact ->
/// transaction-anchored recovery) and renders it ONLY after hash
/// verification against the on-chain commitment. Anything unverified
/// falls back to an honest notice — never a guessed description.
export default function CriteriaDetails({ bountyId, criteriaHash }: { bountyId: number; criteriaHash: string }) {
  const [state, setState] = useState<DetailsState>({ status: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    const shared = getSharedResolver({
      fetchImpl: fetch,
      indexerBaseUrl: config.indexerBaseUrl,
      contractId: config.contractId,
      nearRpcUrl: config.nearRpcUrl,
    });
    shared
      .resolve({ bountyId, criteriaHash })
      .then((r: { ok: boolean; doc?: CriteriaDocLike; reason?: string; detail?: string }) => {
        if (!live) return;
        if (r.ok && r.doc) setState({ status: "ready", doc: r.doc });
        else if (r.reason === "missing") setState({ status: "missing" });
        else setState({ status: "error", message: r.detail ?? "Criteria lookup failed." });
      })
      .catch((e: unknown) => {
        if (live) setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [bountyId, criteriaHash, retry]);

  if (state.status === "loading") {
    return (
      <div className="notice warn">
        <LoadingDots label="Loading the bounty description" />
      </div>
    );
  }

  if (state.status === "missing") {
    return (
      <p className="muted small" role="status">
        The criteria document could not be resolved automatically (no served artifact and no
        discoverable creation transaction for commitment{" "}
        <code className="mono small" title={criteriaHash}>
          {shortenAddress(criteriaHash)}
        </code>
        ). The slot schedule and funding above come from chain state; you can still claim by
        pasting the sponsor&apos;s criteria JSON in the claim form below.{" "}
        <button type="button" onClick={() => setRetry((n) => n + 1)}>
          Retry
        </button>
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="notice error" role="alert">
        Could not load the bounty description: {state.message}{" "}
        <button type="button" onClick={() => setRetry((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  }

  const doc = state.doc;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const checks = Array.isArray(doc.checks?.required)
    ? doc.checks.required.map((c) => str(c?.name)).filter((n): n is string => !!n)
    : [];
  const labels = Array.isArray(doc.labels?.required_all)
    ? doc.labels.required_all.map((l) => str(l)).filter((l): l is string => !!l)
    : [];
  const reviewers = Array.isArray(doc.reviews?.required_approvals)
    ? doc.reviews.required_approvals.map((a) => str(a?.login)).filter((l): l is string => !!l)
    : [];
  const keywords = Array.isArray(doc.issue?.keywords)
    ? doc.issue.keywords.map((k) => str(k)).filter((k): k is string => !!k)
    : [];
  const associations = Array.isArray(doc.author_association)
    ? doc.author_association.map((a) => str(a)).filter((a): a is string => !!a)
    : [];
  const strList = (v: unknown) =>
    Array.isArray(v) ? v.map((s) => str(s)).filter((s): s is string => !!s) : [];
  const allowedPaths = strList(doc.files?.allowed_paths);
  const requiredTouched = strList(doc.files?.required_touched);
  const forbiddenPaths = strList(doc.files?.forbidden_paths);
  const repo = str(doc.repo);
  const issueUrl = str(doc.issue?.url);

  return (
    <div className="card">
      {str(doc.title) && <h3 className="bounty-title">{str(doc.title)}</h3>}
      {str(doc.description) && <p>{str(doc.description)}</p>}
      <dl className="facts">
        {repo && (
          <>
            <dt>Repository</dt>
            <dd className="mono">
              <ExtLink href={`https://github.com/${repo}`}>{repo} ↗</ExtLink>
            </dd>
          </>
        )}
        {issueUrl && (
          <>
            <dt>Issue</dt>
            <dd className="mono">
              <ExtLink href={issueUrl}>{issueUrl} ↗</ExtLink>
              {keywords.length > 0 && <span className="muted small"> ({keywords.join(", ")})</span>}
            </dd>
          </>
        )}
        {str(doc.merge_policy) && (
          <>
            <dt>Merge policy</dt>
            <dd>{str(doc.merge_policy)}</dd>
          </>
        )}
        {associations.length > 0 && (
          <>
            <dt>Author association</dt>
            <dd>{associations.join(", ")}</dd>
          </>
        )}
        {(allowedPaths.length > 0 || requiredTouched.length > 0 || forbiddenPaths.length > 0) && (
          <>
            <dt>File constraints</dt>
            <dd>
              {[
                allowedPaths.length > 0 && `allowed: ${allowedPaths.join(", ")}`,
                requiredTouched.length > 0 && `required: ${requiredTouched.join(", ")}`,
                forbiddenPaths.length > 0 && `forbidden: ${forbiddenPaths.join(", ")}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </>
        )}
        {checks.length > 0 && (
          <>
            <dt>Required checks</dt>
            <dd>{checks.join(", ")}</dd>
          </>
        )}
        {labels.length > 0 && (
          <>
            <dt>Required labels</dt>
            <dd>{labels.join(", ")}</dd>
          </>
        )}
        {reviewers.length > 0 && (
          <>
            <dt>Required reviewers</dt>
            <dd>{reviewers.join(", ")}</dd>
          </>
        )}
      </dl>
      <p className="muted small">Verified against the on-chain criteria hash.</p>
    </div>
  );
}
