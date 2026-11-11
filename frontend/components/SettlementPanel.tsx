"use client";

import { useEffect, useRef, useState } from "react";
import { getVoucher } from "../lib/near";
import type { SignedVoucherView } from "../lib/near";
import { findPayoutTx, isVoucherUsed } from "../lib/base";
import type { PayoutTx } from "../lib/base";
import { baseAddressUrl, baseBlockUrl, baseTxUrl, formatDateTime, formatUsdc, shortenAddress } from "../lib/display.mjs";
import { ExtLink, LoadingDots } from "./ui";

type Phase =
  | { kind: "waiting-voucher" }
  | { kind: "voucher"; voucher: SignedVoucherView; used: boolean | null; payout: PayoutTx | null }
  | { kind: "error"; message: string };

/// Live voucher + settlement tracker. Shows the MPC-signed voucher once the
/// NEAR callback lands, then watches the Base escrow until the relayer
/// settles it, and finally links the real USDC payout transaction. Every
/// state here is read from chain — nothing is simulated.
export default function SettlementPanel({
  bountyId,
  initialVoucher,
  watch,
  voucherTtlSec = 86400,
}: {
  bountyId: number;
  initialVoucher: SignedVoucherView | null;
  watch: boolean;
  voucherTtlSec?: number;
}) {
  const [phase, setPhase] = useState<Phase>(
    initialVoucher ? { kind: "voucher", voucher: initialVoucher, used: null, payout: null } : watch ? { kind: "waiting-voucher" } : { kind: "error", message: "No voucher has been signed for this bounty yet." }
  );
  const [watching, setWatching] = useState(watch);
  const [scan, setScan] = useState<{ scanned: number; total: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!watching) return;
    const tick = async () => {
      setElapsed((e) => e + 1);
      try {
        const v = await getVoucher(bountyId);
        if (!v) return; // still signing
        let used: boolean | null = null;
        let payout: PayoutTx | null = null;
        try {
          used = await isVoucherUsed(v.voucher.digest);
          if (used) {
            setScanning(true);
            setScan(null);
            try {
              payout = await findPayoutTx(bountyId, {
                claimTs: v.voucher.expiry - voucherTtlSec,
                onProgress: (scanned, total) => setScan({ scanned, total }),
              });
            } finally {
              setScanning(false);
            }
          }
        } catch {
          used = null; // escrow unreachable; keep the voucher, retry next tick
        }
        setPhase({ kind: "voucher", voucher: v, used, payout });
        if (used && payout) {
          setWatching(false); // settled: stop polling
        }
      } catch (e) {
        setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        setWatching(false);
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), 15000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [watching, bountyId]);

  const signedDigest = phase.kind === "voucher" ? phase.voucher.voucher.digest : null;

  // Resolve settlement for an already-signed voucher exactly once.
  useEffect(() => {
    if (phase.kind !== "voucher" || phase.used !== null || !watch) return;
    let live = true;
    (async () => {
      try {
        const used = await isVoucherUsed(phase.voucher.voucher.digest);
        let payout: PayoutTx | null = null;
        if (used) {
          setScanning(true);
          setScan(null);
          try {
            payout = await findPayoutTx(bountyId, {
              claimTs: phase.voucher.voucher.expiry - voucherTtlSec,
              onProgress: (scanned, total) => setScan({ scanned, total }),
            });
          } finally {
            setScanning(false);
          }
        }
        if (live) setPhase({ kind: "voucher", voucher: phase.voucher, used, payout });
      } catch {
        if (live) setPhase({ kind: "voucher", voucher: phase.voucher, used: null, payout: null });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedDigest]);

  if (phase.kind === "error") {
    return <div className="notice">{phase.message}</div>;
  }

  if (phase.kind === "waiting-voucher") {
    return (
      <div className="notice warn">
        <LoadingDots label="Waiting for the MPC-signed voucher on NEAR" />
        <p className="muted small">
          The NEAR contract requested a Chain Signatures signing round. This usually lands within a
          minute or two; this panel refreshes automatically ({Math.floor(elapsed * 15 / 60)}m
          {String((elapsed * 15) % 60).padStart(2, "0")}s elapsed).
        </p>
        <button onClick={() => setWatching(false)}>Stop watching</button>
      </div>
    );
  }

  const { voucher, used, payout } = phase;
  return (
    <div className="voucher">
      <h3>Signed voucher</h3>
      <dl className="facts">
        <dt>Digest</dt>
        <dd className="mono">{shortenAddress(voucher.voucher.digest)}</dd>
        <dt>Recipient</dt>
        <dd className="mono">
          <ExtLink href={baseAddressUrl(voucher.voucher.recipient)}>
            {shortenAddress(voucher.voucher.recipient)} ↗
          </ExtLink>
        </dd>
        <dt>Amount</dt>
        <dd className="mono">{formatUsdc(voucher.voucher.amount)} USDC</dd>
        <dt>Nonce</dt>
        <dd className="mono">{voucher.voucher.nonce}</dd>
        <dt>Expires</dt>
        <dd>{formatDateTime(voucher.voucher.expiry)}</dd>
        <dt>Signature</dt>
        <dd className="mono small">
          v={voucher.v} r={shortenAddress(voucher.r)} s={shortenAddress(voucher.s)}
        </dd>
      </dl>
      {used === null ? (
        <div className="notice warn">
          {scanning || scan ? (
            <LoadingDots
              label={
                scan
                  ? `Settled — locating the payout transaction (${scan.scanned}/${scan.total} ranges)`
                  : "Settled — locating the payout transaction"
              }
            />
          ) : (
            <LoadingDots label="Checking Base escrow settlement" />
          )}
        </div>
      ) : used && payout ? (
        <div className="notice ok">
          <strong>Paid out — {formatUsdc(payout.amount)} USDC settled on Base.</strong>
          <div className="txline">
            <span>
              Payout tx{" "}
              <ExtLink href={baseTxUrl(payout.txHash)}>
                <code>{shortenAddress(payout.txHash)} ↗</code>
              </ExtLink>
            </span>
            <span>
              Block{" "}
              <ExtLink href={baseBlockUrl(payout.blockNumber)}>
                <code>{payout.blockNumber} ↗</code>
              </ExtLink>
            </span>
          </div>
        </div>
      ) : used ? (
        <div className="notice ok">
          <strong>Settled on Base.</strong>
          <p className="muted small">
            The escrow marks this voucher used, but the payout transaction was not found in the
            scanned log window. The funds left the escrow —{" "}
            <ExtLink href={baseAddressUrl(voucher.voucher.escrow)}>inspect the escrow ↗</ExtLink>{" "}
            or retry the scan.
          </p>
          {!watching && <button onClick={() => setWatching(true)}>Retry scan</button>}
        </div>
      ) : (
        <div className="notice warn">
          {watching ? (
            <LoadingDots label="Signed — waiting for the relayer to settle on Base" />
          ) : (
            <strong>Signed — not yet settled on Base.</strong>
          )}
          <p className="muted small">
            The relayer submits signed vouchers automatically. No action needed; the payout lands at
            the recipient above.
          </p>
          {!watching && <button onClick={() => setWatching(true)}>Watch for settlement</button>}
        </div>
      )}
    </div>
  );
}
