"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getClaim } from "../lib/near";
import type { ClaimViewV3 } from "../lib/near";
import { summarizeOwnClaimScan } from "../lib/settlement.mjs";
import { createGeneration } from "../lib/submitGuard.mjs";
import { useWallets } from "./wallets";
import SettlementPanel from "./SettlementPanel";
import ErrorBoundary from "./ErrorBoundary";
import { LoadingDots } from "./ui";

type ScanStatus = "idle" | "scanning" | "found" | "none" | "uncertain";

/// Returning-claimant lookup: finds the connected wallet's own V3 claim
/// for this bounty from authoritative chain state (per-slot get_claim
/// reads matched by recipient) and hands it to the standard settlement
/// tracker. Nothing here depends on transient post-submit component
/// state, so refreshes and late arrivals resolve the same way. Failed
/// reads make the outcome uncertain (retry) — never a false "none".
export default function ReturningClaimTracker({ bountyId, slots }: { bountyId: number; slots: string[] }) {
  const { evmAddress, connectEvm } = useWallets();
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [found, setFound] = useState<{ slot: number; claim: ClaimViewV3 } | null>(null);
  const mountedRef = useRef(true);
  const genRef = useRef(createGeneration());
  const scanningRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scan = useCallback(async () => {
    if (!evmAddress) return;
    const gen = genRef.current.issue();
    const stillCurrent = () => mountedRef.current && genRef.current.isCurrent(gen);
    scanningRef.current = true;
    setStatus("scanning");
    setFound(null);
    try {
      const entries: Array<{ slot: number; claim: ClaimViewV3 | null }> = [];
      let failed = 0;
      for (let i = 0; i < Math.min(slots.length, 16); i++) {
        try {
          entries.push({ slot: i, claim: await getClaim(bountyId, i) });
        } catch {
          failed++;
          entries.push({ slot: i, claim: null });
        }
      }
      if (!stillCurrent()) return;
      const summary = summarizeOwnClaimScan(entries, evmAddress, failed) as {
        status: "found" | "none" | "uncertain";
        slot: number | null;
        claim: ClaimViewV3 | null;
      };
      if (summary.status === "found" && summary.claim && summary.slot !== null) {
        setFound({ slot: summary.slot, claim: summary.claim });
        setStatus("found");
      } else if (summary.status === "uncertain") {
        setStatus("uncertain");
      } else {
        setStatus("none");
      }
    } catch {
      if (stillCurrent()) setStatus("uncertain");
    } finally {
      scanningRef.current = false;
    }
  }, [bountyId, slots, evmAddress]);

  useEffect(() => {
    if (!evmAddress) {
      setStatus("idle");
      setFound(null);
      return;
    }
    void scan();
  }, [scan, evmAddress]);

  const retryScan = () => {
    if (scanningRef.current) return;
    void scan();
  };

  if (!evmAddress) {
    return (
      <div className="notice warn" role="status">
        <span className="muted small">
          Connect your EVM wallet to look up a claim you already submitted for this bounty.
        </span>{" "}
        <button type="button" onClick={() => void connectEvm()}>
          Connect EVM wallet
        </button>
      </div>
    );
  }

  if (status === "scanning" || status === "idle") {
    return (
      <div className="notice warn">
        <LoadingDots label="Looking up your claim on NEAR" />
      </div>
    );
  }

  if (status === "uncertain") {
    return (
      <div className="notice warn" role="status">
        <strong>Could not verify your claim.</strong>{" "}
        <span className="muted small">Some claim reads failed — this is not a “no claim” answer.</span>{" "}
        <button type="button" onClick={retryScan}>
          Retry lookup
        </button>
      </div>
    );
  }

  if (status === "none" || !found) {
    return (
      <p className="muted small" role="status">
        No claim from the connected wallet yet — submit one above to get started.
      </p>
    );
  }

  return (
    <div>
      <p className="muted small" role="status">
        Found your claim in slot {found.slot} — tracking it below.
      </p>
      <ErrorBoundary label="settlement tracker" resetKey={`settlement:${bountyId}`}>
        <SettlementPanel
          key={bountyId}
          bountyId={bountyId}
          initialVoucher={null}
          watch={true}
          v3={{ slots, recipient: evmAddress, prNumber: found.claim.pr_number }}
        />
      </ErrorBoundary>
    </div>
  );
}
