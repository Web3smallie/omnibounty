"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getClaim, getClaimByPr, getVoucher, getVoucherV3 } from "../lib/near";
import type { ClaimViewV3, SignedVoucherView, SignedVoucherViewV2 } from "../lib/near";
import { derivePhase, selectOwnClaim } from "../lib/settlement.mjs";
import { createSettlePoller } from "../lib/settlePoll.mjs";
import {
  formatWaitDuration,
  maturedAtSec,
  relayerPipelineStatus,
  settleOverdue,
  stageElapsedSec,
} from "../lib/relayerStatus.mjs";
import { findPayoutTx, isVoucherUsed } from "../lib/base";
import type { PayoutTx } from "../lib/base";
import { baseAddressUrl, baseBlockUrl, baseTxUrl, formatDateTime, formatUsdc, shortenAddress } from "../lib/display.mjs";
import { ExtLink, LoadingDots } from "./ui";

/// Settlement-check lifecycle states (mirrors lib/settlePoll.mjs): only
/// "settled" means paid; "unavailable"/"failed" stop auto-polling and offer
/// a manual retry instead of spinning forever.
type SettleStatus = "checking" | "settled" | "not-settled" | "unavailable" | "failed";

interface SettleSnapshot {
  status: SettleStatus;
  used: boolean | null;
  failures: number;
  error: string | null;
  attempt: number;
}

interface SettlePoller {
  start: () => boolean;
  retry: () => boolean;
  stop: () => void;
}

/// Consecutive NEAR voucher-fetch failures tolerated before the V1 tracker
/// surfaces its error phase: one transient RPC blip must not kill polling.
const VOUCHER_FETCH_MAX_FAILURES = 3;

type Phase =
  | { kind: "waiting-voucher" }
  | {
      kind: "voucher";
      voucher: SignedVoucherView;
      used: boolean | null;
      payout: PayoutTx | null;
      settleStatus: SettleStatus;
      settleError: string | null;
    }
  | { kind: "error"; message: string };

type VoucherLike = SignedVoucherView | SignedVoucherViewV2;

export interface V3Watch {
  slots: string[];
  recipient: string;
  prNumber: number;
}

/// Shared voucher + settlement rendering (V1 and V3 vouchers carry the same
/// display fields). `used === null` means the settlement state is unknown —
/// never shown as paid, and never left spinning without recourse: an
/// exhausted/failed check shows its message with a retry action.
function VoucherDetail({
  bountyId,
  voucher,
  used,
  payout,
  watching,
  scanning,
  scan,
  scanError,
  settleStatus,
  settleError,
  voucherTtlSec,
  onWatch,
  onRetryScan,
  onRetrySettle,
}: {
  bountyId: number;
  voucher: VoucherLike;
  used: boolean | null;
  payout: PayoutTx | null;
  watching: boolean;
  scanning: boolean;
  scan: { scanned: number; total: number } | null;
  scanError: string | null;
  settleStatus: SettleStatus;
  settleError: string | null;
  voucherTtlSec: number;
  onWatch: () => void;
  onRetryScan: () => void;
  onRetrySettle: () => void;
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  // Settlement overdue note: only for a confirmed-unsettled voucher far
  // past creation. Unknown states (used === null) never alarm here —
  // P1-10 owns those, and our own RPC failures are not relayer delays.
  const voucherCreatedAt = voucher.voucher.expiry - voucherTtlSec;
  const settleLate =
    used === false && settleOverdue({ voucherCreatedAt, used, nowSec })
      ? formatWaitDuration(stageElapsedSec(voucherCreatedAt, nowSec))
      : null;
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
        settleStatus === "unavailable" || settleStatus === "failed" ? (
          <div className="notice error" role="alert">
            {settleStatus === "failed" ? "Settlement check failed" : "Settlement check temporarily unavailable"}
            {settleError ? `: ${settleError}` : ""}{" "}
            <button onClick={onRetrySettle}>Retry check</button>
          </div>
        ) : watching ? (
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
        ) : (
          <div className="notice warn" role="status">
            <strong>Settlement check paused.</strong>
            <p className="muted small">
              Automatic settlement checks are off. Resume watching to check the Base escrow again.
            </p>
            <button onClick={onWatch}>Watch for settlement</button>
          </div>
        )
      ) : used && payout ? (
        <div className="notice ok" role="status">
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
      ) : used && scanning ? (
        <div className="notice warn">
          <LoadingDots
            label={
              scan
                ? `Settled — locating the payout transaction (${scan.scanned}/${scan.total} ranges)`
                : "Settled — locating the payout transaction"
            }
          />
        </div>
      ) : used ? (
        <div className="notice ok" role="status">
          <strong>Settled on Base.</strong>
          <p className="muted small">
            The escrow marks this voucher used, but the payout transaction was not found in the
            scanned log window. The funds left the escrow —{" "}
            <ExtLink href={baseAddressUrl(voucher.voucher.escrow)}>inspect the escrow ↗</ExtLink>{" "}
            or retry the scan.
          </p>
          {scanError && <p className="muted small">Last scan failed: {scanError}</p>}
          {!watching && !scanning && <button onClick={onRetryScan}>Retry scan</button>}
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
          {settleLate && (
            <p className="muted small">
              Still not settled after {settleLate} — no settlement observed. The relayer path may be
              delayed or unavailable; chain reads are fine{watching ? " and this panel keeps watching" : ""}.
            </p>
          )}
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
    initialVoucher
      ? { kind: "voucher", voucher: initialVoucher, used: null, payout: null, settleStatus: "checking", settleError: null }
      : watch
        ? { kind: "waiting-voucher" }
        : { kind: "error", message: "No voucher has been signed for this bounty yet." }
  );
  const [watching, setWatching] = useState(watch);
  const [scan, setScan] = useState<{ scanned: number; total: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = useRef(false);
  const voucherRef = useRef<SignedVoucherView | null>(initialVoucher);
  const voucherFailures = useRef(0);
  const pollerRef = useRef<SettlePoller | null>(null);
  const scannedRef = useRef<Set<string>>(new Set());
  const scanningRef = useRef(false);

  // Voucher wait: poll NEAR until the signed voucher appears. Transient
  // fetch failures keep polling (same phase); only persistent failure
  // surfaces the error phase with its manual retry.
  useEffect(() => {
    if (!watching) return;
    let live = true;
    const tick = async () => {
      if (busy.current) return;
      if (voucherRef.current) return; // voucher held: the poller owns settlement now
      busy.current = true;
      if (live) setElapsed((e) => e + 1);
      try {
        const v = await getVoucher(bountyId);
        voucherFailures.current = 0;
        if (!live) return;
        if (!v) {
          // Still signing (also recovers the panel if a retry follows an error).
          setPhase({ kind: "waiting-voucher" });
          return;
        }
        voucherRef.current = v;
        setPhase({ kind: "voucher", voucher: v, used: null, payout: null, settleStatus: "checking", settleError: null });
      } catch (e) {
        voucherFailures.current += 1;
        if (live && voucherFailures.current >= VOUCHER_FETCH_MAX_FAILURES) {
          setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
          setWatching(false);
        }
      } finally {
        busy.current = false;
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), 15000);
    return () => {
      live = false;
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [watching, bountyId]);

  // Payout-log scan: one attempt per digest, then only via the manual
  // retry. A failed scan keeps the confirmed used=true — it only leaves
  // the payout link missing, never downgrades settlement to unknown.
  const runPayoutScan = useCallback(
    async (digest: string) => {
      if (scanningRef.current || scannedRef.current.has(digest)) return;
      scanningRef.current = true;
      scannedRef.current.add(digest);
      setScanning(true);
      setScan(null);
      setScanError(null);
      try {
        const v = voucherRef.current;
        if (!v || v.voucher.digest !== digest) return;
        const payout = await findPayoutTx(bountyId, {
          claimTs: v.voucher.expiry - voucherTtlSec,
          onProgress: (scanned: number, total: number) => setScan({ scanned, total }),
        });
        setPhase((p) => (p.kind === "voucher" && p.voucher.voucher.digest === digest ? { ...p, payout } : p));
      } catch (e) {
        setScanError(e instanceof Error ? e.message : String(e));
      } finally {
        scanningRef.current = false;
        setScanning(false);
      }
    },
    [bountyId, voucherTtlSec]
  );

  const signedDigest = phase.kind === "voucher" ? phase.voucher.voucher.digest : null;

  // Settlement check: the poller retries unknown reads with bounded
  // backoff, ignores stale settlements, and stops itself (timer cancelled,
  // late updates dropped) on unmount or when watching pauses.
  useEffect(() => {
    if (!signedDigest || !watching) return;
    const digest = signedDigest;
    const poller: SettlePoller = createSettlePoller({
      read: () => isVoucherUsed(digest),
      baseMs: 15000,
      onState: (s: SettleSnapshot) => {
        if (s.status === "settled") {
          setPhase((p) =>
            p.kind === "voucher" && p.voucher.voucher.digest === digest
              ? { ...p, used: true, settleStatus: "settled", settleError: null }
              : p
          );
          // Settled: stop auto-polling (a missing payout link has its own retry).
          setWatching(false);
          void runPayoutScan(digest);
        } else if (s.status === "not-settled") {
          setPhase((p) =>
            p.kind === "voucher" && p.voucher.voucher.digest === digest
              ? { ...p, used: false, settleStatus: "not-settled", settleError: null }
              : p
          );
        } else if (s.status === "unavailable" || s.status === "failed") {
          setPhase((p) =>
            p.kind === "voucher" && p.voucher.voucher.digest === digest
              ? { ...p, used: null, settleStatus: s.status, settleError: s.error }
              : p
          );
        } else {
          setPhase((p) =>
            p.kind === "voucher" && p.voucher.voucher.digest === digest
              ? { ...p, settleStatus: "checking", settleError: s.error }
              : p
          );
        }
      },
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
    // Intentional: the poller must not restart when the scan callback identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedDigest, watching]);

  if (phase.kind === "error") {
    return (
      <div className="notice error" role="alert">
        {phase.message}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            onClick={() => {
              setElapsed(0);
              voucherFailures.current = 0;
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

  const { voucher, used, payout, settleStatus, settleError } = phase;
  return (
    <VoucherDetail
      bountyId={bountyId}
      voucher={voucher}
      used={used}
      payout={payout}
      watching={watching}
      scanning={scanning}
      scan={scan}
      scanError={scanError}
      settleStatus={settleStatus}
      settleError={settleError}
      voucherTtlSec={voucherTtlSec}
      onWatch={() => setWatching(true)}
      onRetryScan={() => {
        scannedRef.current.delete(voucher.voucher.digest);
        void runPayoutScan(voucher.voucher.digest);
      }}
      onRetrySettle={() => pollerRef.current?.retry()}
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
  const [scanError, setScanError] = useState<string | null>(null);
  const [settleStatus, setSettleStatus] = useState<SettleStatus>("checking");
  const [settleError, setSettleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = useRef(false);
  const slotRef = useRef<number | null>(null);
  const pollerRef = useRef<SettlePoller | null>(null);
  const scannedRef = useRef<Set<string>>(new Set());
  const scanningRef = useRef(false);

  useEffect(() => {
    if (!watching) return;
    let live = true;
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
            if (live) setSlot(s);
          }
        }
        // Every chain read degrades to null on transport failure, so a
        // transient RPC blip surfaces as "not yet" and recovers next tick —
        // polling here never stops on error (settlement has its own poller
        // below with bounded backoff and explicit unavailable/failed states).
        const c = s !== null ? await getClaim(bountyId, s).catch(() => null) : null;
        if (live) setClaim(c);
        const v = s !== null ? await getVoucherV3(bountyId, s).catch(() => null) : null;
        if (live) setVoucher(v);
        const derived = derivePhase({ claim: c, voucher: v, used: null });
        if (live) setWaitSec(derived.phase === "qualified" ? derived.waitSec ?? null : null);
        if (live) setError(null);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy.current = false;
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), 10000);
    return () => {
      live = false;
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
    // Intentional: the interval must not restart on prop identity churn (slots is an array).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, bountyId]);

  // Payout-log scan: one attempt per digest, then only via the manual
  // retry. A failed scan keeps the confirmed used=true — it only leaves
  // the payout link missing, never downgrades settlement to unknown.
  const runPayoutScan = useCallback(
    async (target: SignedVoucherViewV2) => {
      const digest = target.voucher.digest;
      if (scanningRef.current || scannedRef.current.has(digest)) return;
      scanningRef.current = true;
      scannedRef.current.add(digest);
      setScanning(true);
      setScan(null);
      setScanError(null);
      try {
        const payout = await findPayoutTx(bountyId, {
          claimTs: target.voucher.expiry - voucherTtlSec,
          onProgress: (scanned: number, total: number) => setScan({ scanned, total }),
        });
        setPayout(payout);
        setError(null);
      } catch (e) {
        setScanError(e instanceof Error ? e.message : String(e));
      } finally {
        scanningRef.current = false;
        setScanning(false);
      }
    },
    [bountyId, voucherTtlSec]
  );

  const voucherDigest = voucher ? voucher.voucher.digest : null;

  // Settlement check: same lifecycle as the V1 tracker — bounded backoff
  // on unknown reads, stale settlements ignored, timer cancelled and
  // late updates dropped on unmount or when watching pauses.
  useEffect(() => {
    if (!voucher || !watching) return;
    const target = voucher;
    const poller: SettlePoller = createSettlePoller({
      read: () => isVoucherUsed(target.voucher.digest),
      baseMs: 10000,
      onState: (s: SettleSnapshot) => {
        if (s.status === "settled") {
          setUsed(true);
          setSettleStatus("settled");
          setSettleError(null);
          // Settled: stop auto-polling (a missing payout link has its own retry).
          setWatching(false);
          void runPayoutScan(target);
        } else if (s.status === "not-settled") {
          setUsed(false);
          setSettleStatus("not-settled");
          setSettleError(null);
        } else if (s.status === "unavailable" || s.status === "failed") {
          setUsed(null);
          setSettleStatus(s.status);
          setSettleError(s.error);
        } else {
          setSettleStatus("checking");
          setSettleError(s.error);
        }
      },
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
    // Intentional: the poller keys off the digest string, not voucher/scan-callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voucherDigest, watching]);

  const derived = derivePhase({ claim, voucher, used });
  const stepIdx = V3_STEPS.indexOf(derived.phase as (typeof V3_STEPS)[number]);
  // Evidence-based pipeline status: overdue alarms only when our reads
  // are healthy (error === null), so RPC failures never read as relayer
  // delays — those stay on the P1-10 unknown/unavailable path.
  const pipeNowSec = Math.floor(Date.now() / 1000);
  const pipe = relayerPipelineStatus({
    phase: derived.phase,
    claim,
    used,
    readsOk: error === null,
    nowSec: pipeNowSec,
  }) as { status: string; stage?: string; sinceSec?: number };
  const finalizeWaited = formatWaitDuration(
    stageElapsedSec(maturedAtSec(claim), pipeNowSec)
  ) as string;

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
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {derived.phase === "qualifying" && (
        <div className="notice warn">
          <LoadingDots label="Waiting for qualification to confirm on NEAR" />
        </div>
      )}
      {derived.phase === "qualified" && (
        <div className="notice warn">
          <LoadingDots label={`Qualified — challenge window ends in ${waitSec ?? "?"}s`} />
          <p className="muted small">
            No action needed — matured claims are picked up for finalization automatically.
          </p>
        </div>
      )}
      {derived.phase === "finalizing" && (
        <div className="notice warn">
          {pipe.status === "delayed" ? (
            <>
              <LoadingDots label={`Matured — finalization delayed (${finalizeWaited})`} />
              <p className="muted small">
                No finalization observed {finalizeWaited} past maturity. The finalization path may be
                delayed or unavailable; chain reads are fine and this panel keeps watching — no
                action needed.
              </p>
            </>
          ) : (
            <>
              <LoadingDots label={`Matured — waiting for finalization (${finalizeWaited})`} />
              <p className="muted small">
                The claim is eligible; matured claims are picked up automatically. No action needed.
              </p>
            </>
          )}
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
          scanError={scanError}
          settleStatus={settleStatus}
          settleError={settleError}
          voucherTtlSec={voucherTtlSec}
          onWatch={() => setWatching(true)}
          onRetryScan={() => {
            scannedRef.current.delete(voucher.voucher.digest);
            void runPayoutScan(voucher);
          }}
          onRetrySettle={() => pollerRef.current?.retry()}
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
