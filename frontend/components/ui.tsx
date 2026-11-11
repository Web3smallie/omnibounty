import type { ReactNode } from "react";

/// External link (explorers, GitHub): always a new tab with opener safety.
export function ExtLink({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title}>
      {children}
    </a>
  );
}

/// Bounty lifecycle pill. Only the contract's own statuses are shown —
/// nothing is inferred or invented.
export function StatusPill({ status }: { status: string }) {
  const cls =
    status === "open" ? "pill pill-open" : status === "pending" ? "pill pill-pending" : "pill pill-claimed";
  const label = status === "open" ? "Open" : status === "pending" ? "Signing" : status === "claimed" ? "Claimed" : status;
  return <span className={cls}>{label}</span>;
}

export function FundingPill({ funded, claimed }: { funded: boolean | null; claimed: boolean | null }) {
  if (funded === null || claimed === null) return <span className="pill pill-unknown">Escrow…</span>;
  if (claimed) return <span className="pill pill-claimed">Paid out</span>;
  if (funded) return <span className="pill pill-funded">Funded</span>;
  return <span className="pill pill-unfunded">Unfunded</span>;
}

export function LoadingDots({ label }: { label: string }) {
  return (
    <span className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}
