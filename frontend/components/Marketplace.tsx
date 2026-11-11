"use client";

import { useEffect, useState } from "react";
import type { BountyView } from "../lib/near";
import { escrowBountyState } from "../lib/base";
import type { EscrowBountyState } from "../lib/base";
import { bountyTitle, formatDateTime, formatUsdc, githubPrUrl, timeAgo } from "../lib/display.mjs";
import { ExtLink, FundingPill, StatusPill } from "./ui";

function useEscrowState(bountyId: number): EscrowBountyState | null | "error" {
  const [state, setState] = useState<EscrowBountyState | null | "error">(null);
  useEffect(() => {
    let live = true;
    escrowBountyState(bountyId)
      .then((s) => {
        if (live) setState(s);
      })
      .catch(() => {
        if (live) setState("error");
      });
    return () => {
      live = false;
    };
  }, [bountyId]);
  return state;
}

export function BountyCard({ bounty }: { bounty: BountyView }) {
  const escrow = useEscrowState(bounty.id);
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
        <a href={`/bounties/${bounty.id}`}>{bountyTitle(bounty)}</a>
      </h3>
      <div className="bounty-amount">{formatUsdc(bounty.amount)} USDC</div>
      <div className="card-meta">
        <span>#{bounty.id}</span>
        <span title={formatDateTime(bounty.created_at)}>{timeAgo(bounty.created_at)}</span>
        <ExtLink href={githubPrUrl(bounty.repo, bounty.pr_number)}>View PR ↗</ExtLink>
      </div>
    </article>
  );
}

type StatusFilter = "all" | "open" | "pending" | "claimed";

export default function Marketplace({ bounties }: { bounties: BountyView[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const q = query.trim().toLowerCase();
  const visible = bounties
    .filter((b) => (filter === "all" ? true : b.status === filter))
    .filter((b) =>
      q === "" ? true : b.repo.toLowerCase().includes(q) || String(b.id) === q || `#${b.id}` === q
    )
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
        <p className="muted">No bounties match this search.</p>
      ) : (
        <div className="grid">
          {visible.map((b) => (
            <BountyCard key={b.id} bounty={b} />
          ))}
        </div>
      )}
    </section>
  );
}
