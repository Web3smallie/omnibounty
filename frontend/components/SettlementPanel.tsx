"use client";

import { useEffect, useRef, useState } from "react";
import { getClaim, getClaimByPr, getVoucher, getVoucherV3 } from "../lib/near";
import type { ClaimViewV3, SignedVoucherView, SignedVoucherViewV2 } from "../lib/near";
import { derivePhase, selectOwnClaim } from "../lib/settlement.mjs";
import { findPayoutTx, isVoucherUsed } from "../lib/base";
import type { PayoutTx } from "../lib/base";
import { baseAddressUrl, baseBlockUrl, baseTxUrl, formatDateTime, formatUsdc, shortenAddress } from "../lib/display.mjs";
import { ExtLink, LoadingDots } from "./ui";

type Phase =
  | { kind: "waiting-voucher" }
  | { kind: "voucher"; voucher: SignedVoucherView; used: boolean | null; payout: PayoutTx | null }
  | { kind: "error"; message: string };

type VoucherLike = SignedVoucherView | SignedVoucherViewV2;

export interface V3Watch {
  slots: string[];
  recipient: string;
  prNumber: number;
}

/// Shared voucher + settlement rendering (V1 and V3 vouchers carry the same
/// display fields). `used === null` means still checking — never shown as paid.
function VoucherDetail({
  bountyId,
  voucher,
  used,
  payout,
  watching,
  scanning,
  scan,
  voucherTtlSec,
  onWatch,
}: {
  bountyId: number;
  voucher: VoucherLike;
  used: boolean | null;
  payout: PayoutTx | null;
  watching: boolean;
  scanning: boolean;
  scan: { scanned: number; total: number } | null;
  voucherTtlSec: number;
  onWatch: () => void;
}) {
  void voucherTtlSec;
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
          {!watching && <button onClick={onWatch}>Retry scan</button>}
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
          {!watching && <button onClick={onWatch}>Watch for settlement</button>}
        </div>
      )}
    </div>
  );
}

/// V1 tracker: today's behavior, unchanged.
function V1Tracker({
  bountyId,
  initialVoucher,
  watch,
  voucherTtlSec,
}: {
  bountyId: number;
  initialVoucher: SignedVoucherView | null;
  watch: boolean;
  voucherTtlSec: number;
}) {
  const [phase, setPhase] = useState<Phase>(
    initialVoucher ? { kind: "voucher", voucher: initialVoucher, used: null, payout: null } : watch ? { kind: "waiting-voucher" } : { kind: "error", message: "No voucher has been signed for this bounty yet." }
  );
  const [watching, setWatching] = useState(watch);
  const [scan, setScan] = useState<{ scanned: number; total: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!watching) return;
    const tick = async () => {
      // A payout-log scan can outlast the 15s interval: never overlap ticks.
      if (busy.current) return;
      busy.current = true;
      setElapsed((e) => e + 1);
      try {
        const v = await getVoucher(bountyId);
        if (!v) {
          // Still signing (also recovers the panel if a retry follows an error).
          setPhase({ kind: "waiting-voucher" });
          return;
        }
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
        if (used) {
          // Settled: stop auto-polling (a missing payout link has its own retry).
          setWatching(false);
        }
      } catch (e) {
        setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        setWatching(false);
      } finally {
        busy.current = false;
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), 15000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    return (
      <div className="notice error">
        {phase.message}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            onClick={() => {
              setElapsed(0);
              setWatching(true);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
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
    <VoucherDetail
      bountyId={bountyId}
      voucher={voucher}
      used={used}
      payout={payout}
      watching={watching}
      scanning={scanning}
      scan={scan}
      voucherTtlSec={voucherTtlSec}
      onWatch={() => setWatching(true)}
    />
  );
}

const V3_STEPS = ["qualified", "finalizing", "signing", "settling", "paid"] as const;

/// V3 tracker: claim -> finalize -> MPC signing -> settlement, every step
/// read from chain. The slot is resolved by PR (exact: one PR claims a
/// bounty at most once), falling back to a recipient scan across slots.
function V3Tracker({
  bountyId,
  slots,
  recipient,
  prNumber,
  voucherTtlSec,
}: {
  bountyId: number;
  slots: string[];
  recipient: string;
  prNumber: number;
  voucherTtlSec: number;
}) {
  const [slot, setSlot] = useState<number | null>(null);
  const [claim, setClaim] = useState<ClaimViewV3 | null>(null);
  const [voucher, setVoucher] = useState<SignedVoucherViewV2 | null>(null);
  const [used, setUsed] = useState<boolean | null>(null);
  const [payout, setPayout] = useState<PayoutTx | null>(null);
  const [waitSec, setWaitSec] = useState<number | null>(null);
  const [watching, setWatching] = useState(true);
  const [scan, setScan] = useState<{ scanned: number; total: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = useRef(false);
  const slotRef = useRef<number | null>(null);

  useEffect(() => {
    if (!watching) return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        let s = slotRef.current;
        if (s === null) {
          try {
            const byPr = await getClaimByPr(bountyId, prNumber);
            if (typeof byPr === "number") s = byPr;
          } catch {
            s = null;
          }
          if (s === null && slots.length > 0) {
            const entries: Array<{ slot: number; claim: ClaimViewV3 | null }> = [];
            for (let i = 0; i < Math.min(slots.length, 16); i++) {
              try {
                entries.push({ slot: i, claim: await getClaim(bountyId, i) });
              } catch {
                entries.push({ slot: i, claim: null });
              }
            }
            const own = selectOwnClaim(entries, recipient);
            if (own) s = own.slot;
          }
          if (s !== null) {
            slotRef.current = s;
            setSlot(s);
          }
        }
        const c = s !== null ? await getClaim(bountyId, s).catch(() => null) : null;
        setClaim(c);
        const v = s !== null ? await getVoucherV3(bountyId, s).catch(() => null) : null;
        setVoucher(v);
        const derived = derivePhase({ claim: c, voucher: v, used });
        setWaitSec(derived.phase === "qualified" ? derived.waitSec ?? null : null);
        if (v) {
          try {
            const u = await isVoucherUsed(v.voucher.digest);
            setUsed(u);
            if (u) {
              setScanning(true);
              setScan(null);
              try {
                setPayout(
                  await findPayoutTx(bountyId, {
                    claimTs: v.voucher.expiry - voucherTtlSec,
                    onProgress: (scanned, total) => setScan({ scanned, total }),
                  })
                );
              } finally {
                setScanning(false);
              }
              setWatching(false);
            }
          } catch {
            setUsed(null);
          }
        }
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy.current = false;
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), 10000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, bountyId]);

  const derived = derivePhase({ claim, voucher, used });
  const stepIdx = V3_STEPS.indexOf(derived.phase as (typeof V3_STEPS)[number]);

  return (
    <div>
      <p className="muted small" aria-live="polite">
        {V3_STEPS.map((s, i) => (
          <span key={s}>
            {i > 0 && " · "}
            <span style={{ fontWeight: i === stepIdx ? 700 : 400 }}>
              {i < stepIdx || derived.phase === "paid" ? "✓ " : i === stepIdx ? "… " : ""}
              {s[0].toUpperCase() + s.slice(1)}
            </span>
          </span>
        ))}
        {slot !== null && <span> (slot {slot})</span>}
      </p>
      {error && <div className="notice error">{error}</div>}
      {derived.phase === "qualifying" && (
        <div className="notice warn">
          <LoadingDots label="Waiting for qualification to confirm on NEAR" />
        </div>
      )}
      {derived.phase === "qualified" && (
        <div className="notice warn">
          <LoadingDots label={`Qualified — challenge window ends in ${waitSec ?? "?"}s`} />
          <p className="muted small">
            The relayer submits finalization automatically once the window elapses. No action needed.
          </p>
        </div>
      )}
      {derived.phase === "finalizing" && (
        <div className="notice warn">
          <LoadingDots label="Matured — the relayer is submitting finalization" />
          <p className="muted small">
            The claim is eligible; the relayer&apos;s next poll (≤30s) dispatches the MPC signing
            round. No action needed.
          </p>
        </div>
      )}
      {derived.phase === "signing" && (
        <div className="notice warn">
          <LoadingDots label="MPC signing round in flight" />
          <p className="muted small">
            The NEAR contract requested a Chain Signatures round for this slot. This usually lands
            within a minute or two.
          </p>
        </div>
      )}
      {(derived.phase === "settling" || derived.phase === "paid") && voucher && (
        <VoucherDetail
          bountyId={bountyId}
          voucher={voucher}
          used={derived.phase === "paid" ? true : used}
          payout={payout}
          watching={watching}
          scanning={scanning}
          scan={scan}
          voucherTtlSec={voucherTtlSec}
          onWatch={() => setWatching(true)}
        />
      )}
      {(derived.phase === "settling") && !voucher && (
        <div className="notice warn">
          <LoadingDots label="Signed — fetching the voucher" />
        </div>
      )}
    </div>
  );
}

/// Live voucher + settlement tracker. Shows the MPC-signed voucher once the
/// NEAR callback lands, then watches the Base escrow until the relayer
/// settles it, and finally links the real USDC payout transaction. Every
/// state here is read from chain — nothing is simulated.
export default function SettlementPanel({
  bountyId,
  initialVoucher,
  watch,
  voucherTtlSec = 86400,
  v3,
}: {
  bountyId: number;
  initialVoucher: SignedVoucherView | null;
  watch: boolean;
  voucherTtlSec?: number;
  v3?: V3Watch;
}) {
  if (v3) {
    return (
      <V3Tracker
        bountyId={bountyId}
        slots={v3.slots}
        recipient={v3.recipient}
        prNumber={v3.prNumber}
        voucherTtlSec={voucherTtlSec}
      />
    );
  }
  return <V1Tracker bountyId={bountyId} initialVoucher={initialVoucher} watch={watch} voucherTtlSec={voucherTtlSec} />;
}
