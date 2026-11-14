"use client";

import { useEffect, useState } from "react";
import type { BountyView, BountyViewV3 } from "../lib/near";
import { escrowBountyState, escrowBountyStateV2 } from "../lib/base";
import type { EscrowBountyState } from "../lib/base";
import { escrowReads } from "../lib/escrowPool.mjs";
import { bountyTitleV3 } from "../lib/settlement.mjs";
import {
  bountyCardAmountText,
  bountyCardPrUrl,
  bountyCardSlotsText,
  bountyMatchesQuery,
  bountyTitle,
  formatDateTime,
  isClaimableOpen,
  shortenAddress,
  timeAgo,
  v3EscrowCardState,
} from "../lib/display.mjs";
import { ExtLink, FundingPill, StatusPill } from "./ui";
import ErrorBoundary from "./ErrorBoundary";

function isV3(bounty: BountyView | BountyViewV3): bounty is BountyViewV3 {
  return (bounty as BountyViewV3).criteria_hash !== undefined;
}

/// Typed view of the shared escrow-read pool (lib/escrowPool.mjs).
interface EscrowReadPool {
  run<T>(key: string, task: () => Promise<T>): { promise: Promise<T>; cancel: () => void };
}

const pool: EscrowReadPool = escrowReads;

function useEscrowState(bounty: BountyView | BountyViewV3): EscrowBountyState | null | "error" {
  const [state, setState] = useState<EscrowBountyState | null | "error">(null);
  useEffect(() => {
    let live = true;
    // Version routing by bounty shape; each reader additionally refuses
    // to decode unless the deployed escrow probes as its version, so a
    // mismatched configuration fails loud instead of mis-decoding.
    // Reads run through the shared pool (bounded app-wide): identical
    // in-flight reads are shared instead of duplicated, the rest queue,
    // and unmounting frees the card's hold without disturbing other cards.
    const v3 = isV3(bounty);
    const task = v3
      ? () =>
          escrowBountyStateV2(bounty.id).then((s) => {
            const mapped = v3EscrowCardState(s);
            if (!mapped) throw new Error("malformed V2 escrow state");
            return mapped;
          })
      : () => escrowBountyState(bounty.id);
    const { promise, cancel } = pool.run(`v${v3 ? 2 : 1}:${bounty.id}`, task);
    promise.then(
      (s) => {
        if (live) setState(s);
      },
      () => {
        if (live) setState("error");
      }
    );
    return () => {
      live = false;
      cancel();
    };
  }, [bounty]);
  return state;
}

export function BountyCard({ bounty }: { bounty: BountyView | BountyViewV3 }) {
  const escrow = useEscrowState(bounty);
  const v3 = isV3(bounty);
  const amount = bountyCardAmountText(bounty);
  const prUrl = bountyCardPrUrl(bounty);
  const slots = bountyCardSlotsText(bounty);
  return (
    <article className="card bounty-card">
      <div className="card-top">
        <StatusPill status={bounty.status} />
        {escrow === "error" ? (
          <span className="pill pill-unknown">Escrow unreachable</span>
        ) : (
          <FundingPill funded={escrow?.funded ?? null} claimed={escrow?.claimed ?? null} />
        )}
      </div>
      <h3 className="bounty-title">
        <a href={`/bounties/${bounty.id}`}>{v3 ? bountyTitleV3(bounty) : bountyTitle(bounty)}</a>
      </h3>
      <div className="bounty-amount">{amount !== null ? `${amount} USDC` : "Amount unavailable"}</div>
      <div className="card-meta">
        <span>#{bounty.id}</span>
        <span title={formatDateTime(bounty.created_at)}>{timeAgo(bounty.created_at)}</span>
        {v3 ? (
          <>
            {slots !== null ? <span>{slots}</span> : null}
            <span className="mono small" title={bounty.criteria_hash}>
              {shortenAddress(bounty.criteria_hash)}
            </span>
          </>
        ) : prUrl !== null ? (
          <ExtLink href={prUrl}>View PR ↗</ExtLink>
        ) : null}
      </div>
    </article>
  );
}

type StatusFilter = "all" | "open" | "pending" | "claimed";

export default function Marketplace({ bounties }: { bounties: (BountyView | BountyViewV3)[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const q = query.trim().toLowerCase();
  const visible = bounties
    .filter((b) => (filter === "all" ? true : filter === "open" ? isClaimableOpen(b) : b.status === filter))
    .filter((b) => bountyMatchesQuery(b, q))
    .sort((a, b) => b.id - a.id);

  return (
    <section id="browse" className="market">
      <div className="market-controls">
        <input
          type="search"
          className="search"
          placeholder="Search by repository or bounty #id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search bounties"
        />
        <div className="filters" role="group" aria-label="Filter by status">
          {(["all", "open", "pending", "claimed"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              className={filter === s ? "filter filter-on" : "filter"}
              onClick={() => setFilter(s)}
              aria-pressed={filter === s}
            >
              {s === "all" ? "All" : s === "open" ? "Open" : s === "pending" ? "Signing" : "Claimed"}
            </button>
          ))}
        </div>
      </div>
      {bounties.length === 0 ? (
        <p className="muted">
          No bounties on the contract yet. Sponsors can create the first one from “New bounty”.
        </p>
      ) : visible.length === 0 ? (
        <p className="muted" role="status">
          No bounties match this search.
        </p>
      ) : (
        <div className="grid">
          {visible.map((b) => (
            <ErrorBoundary key={b.id} label="bounty card" resetKey={`bounty-card:${b.id}`}>
              <BountyCard bounty={b} />
            </ErrorBoundary>
          ))}
        </div>
      )}
    </section>
  );
}
