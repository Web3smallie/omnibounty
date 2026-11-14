import { getBounty, getBountyV3, getConfig, getVoucher } from "../../../lib/near";
import type { BountyView, BountyViewV3 } from "../../../lib/near";
import { config } from "../../../lib/config";
import ClaimForm from "../../../components/ClaimForm";
import ClaimFormV3 from "../../../components/ClaimFormV3";
import SettlementPanel from "../../../components/SettlementPanel";
import { ExtLink, StatusPill } from "../../../components/ui";
import EscrowState from "../../../components/EscrowState";
import ErrorBoundary from "../../../components/ErrorBoundary";
import ReturningClaimTracker from "../../../components/ReturningClaimTracker";
import CriteriaDetails from "../../../components/CriteriaDetails";
import { bountyCriteriaV3, bountyTitleV3 } from "../../../lib/settlement.mjs";
import {
  baseAddressUrl,
  bountyCriteria,
  bountyTitle,
  formatDateTime,
  formatExpiry,
  formatUsdc,
  githubPrUrl,
  nearAccountUrl,
  shortenAddress,
} from "../../../lib/display.mjs";

export const dynamic = "force-dynamic";

function isV3(bounty: BountyView | BountyViewV3): bounty is BountyViewV3 {
  return (bounty as BountyViewV3).criteria_hash !== undefined;
}

export default async function BountyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bountyId = Number(id);
  if (!Number.isInteger(bountyId) || bountyId < 0) {
    return <div className="notice error">Invalid bounty id.</div>;
  }
  // V1 and V3 bounties share the `get_bounty` view name with different
  // shapes; the presence of `criteria_hash` tells them apart.
  let bounty: BountyView | BountyViewV3 | null = null;
  let voucher = null;
  let voucherTtlSec = 86400;
  let error: string | null = null;
  try {
    const raw = (await getBountyV3(bountyId)) as unknown as BountyView | BountyViewV3 | null;
    bounty = raw;
    if (raw && !isV3(raw)) {
      voucher = await getVoucher(bountyId);
    }
    try {
      voucherTtlSec = (await getConfig()).voucher_ttl_sec;
    } catch {
      voucherTtlSec = 86400;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (error) return <div className="notice error">Failed to load bounty: {error}</div>;
  if (!bounty) return <div className="notice warn">Bounty #{bountyId} does not exist on NEAR.</div>;

  if (isV3(bounty)) return <BountyPageV3 bounty={bounty} />;

  const expired = bounty.expiry !== 0 && bounty.expiry * 1000 <= Date.now();

  return (
    <>
      <p className="crumbs">
        <a href="/">Bounties</a> / #{bounty.id}
      </p>
      <div className="detail-head">
        <div>
          <h1 className="bounty-title-lg">{bountyTitle(bounty)}</h1>
          <p className="muted">{bountyCriteria(bounty)}</p>
        </div>
        <div className="detail-amount">
          <span className="amount-lg">{formatUsdc(bounty.amount)} USDC</span>
          <span className="pills">
            <StatusPill status={bounty.status} />
            <ErrorBoundary label="escrow status" resetKey={`escrow:${bounty.id}`}>
              <EscrowState bountyId={bounty.id} />
            </ErrorBoundary>
          </span>
        </div>
      </div>

      <dl className="facts detail-facts">
        <dt>Pull request</dt>
        <dd>
          <ExtLink href={githubPrUrl(bounty.repo, bounty.pr_number)}>
            {bounty.repo}#{bounty.pr_number} ↗
          </ExtLink>
        </dd>
        <dt>Token</dt>
        <dd className="mono">
          <ExtLink href={baseAddressUrl(bounty.token)}>{bounty.token} ↗</ExtLink>
        </dd>
        <dt>Sponsor (NEAR)</dt>
        <dd className="mono">
          <ExtLink href={nearAccountUrl(config.networkId, bounty.sponsor)}>
            {bounty.sponsor} ↗
          </ExtLink>
        </dd>
        <dt>Deadline</dt>
        <dd>
          {formatExpiry(bounty.expiry)}
          {expired && <span className="pill pill-unfunded">Expired</span>}
        </dd>
        <dt>Created</dt>
        <dd>{formatDateTime(bounty.created_at)}</dd>
      </dl>

      <h2>Claim</h2>
      {bounty.status !== "open" ? (
        <p className="muted">
          This bounty is {bounty.status}; new claims are not accepted.
        </p>
      ) : (
        <ErrorBoundary label="claim form" resetKey={`claim:${bounty.id}`}>
          <ClaimForm
            key={bounty.id}
            bountyId={bounty.id}
            bountyRepo={bounty.repo}
            bountyPrNumber={bounty.pr_number}
            bountyExpired={expired}
          />
        </ErrorBoundary>
      )}

      {(voucher || bounty.status !== "open") && (
        <>
          <h2>Voucher &amp; settlement</h2>
          <ErrorBoundary label="settlement tracker" resetKey={`settlement:${bounty.id}`}>
            <SettlementPanel
              key={bounty.id}
              bountyId={bounty.id}
              initialVoucher={voucher}
              watch={true}
              voucherTtlSec={voucherTtlSec}
            />
          </ErrorBoundary>
        </>
      )}
    </>
  );
}

function BountyPageV3({ bounty }: { bounty: BountyViewV3 }) {
  const expired = bounty.deadline !== 0 && bounty.deadline * 1000 <= Date.now();
  const full = bounty.slots_filled >= bounty.slots.length;
  const closedReason = expired
    ? "This bounty is past its deadline; new claims are not accepted."
    : full
      ? "All claim slots are filled; new claims are not accepted."
      : !bounty.funded
        ? "This bounty is not funded yet; claims open once the sponsor funds the escrow."
        : null;

  return (
    <>
      <p className="crumbs">
        <a href="/">Bounties</a> / #{bounty.id}
      </p>
      <div className="detail-head">
        <div>
          <h1 className="bounty-title-lg">{bountyTitleV3(bounty)}</h1>
          <p className="muted">{bountyCriteriaV3(bounty)}</p>
        </div>
        <div className="detail-amount">
          <span className="amount-lg">{formatUsdc(bounty.total_amount)} USDC</span>
          <span className="pills">
            <StatusPill status={bounty.status} />
            {bounty.funded ? (
              <span className="pill pill-funded">Funded</span>
            ) : (
              <span className="pill pill-unfunded">Unfunded</span>
            )}
          </span>
        </div>
      </div>

      <dl className="facts detail-facts">
        <dt>Slots</dt>
        <dd className="mono">
          {bounty.slots.map((a, i) => (
            <span key={i}>
              {i > 0 && " · "}#{i}: {formatUsdc(a)}
            </span>
          ))}{" "}
          ({bounty.slots_filled}/{bounty.slots.length} claimed)
        </dd>
        <dt>Token</dt>
        <dd className="mono">
          <ExtLink href={baseAddressUrl(bounty.token)}>{bounty.token} ↗</ExtLink>
        </dd>
        <dt>Sponsor (NEAR)</dt>
        <dd className="mono">
          <ExtLink href={nearAccountUrl(config.networkId, bounty.sponsor)}>
            {bounty.sponsor} ↗
          </ExtLink>
        </dd>
        <dt>Criteria hash</dt>
        <dd className="mono small">{shortenAddress(bounty.criteria_hash)}</dd>
        <dt>Challenge window</dt>
        <dd>{bounty.challenge_window === 0 ? "None — claims finalize immediately" : `${bounty.challenge_window}s`}</dd>
        <dt>Deadline</dt>
        <dd>
          {formatExpiry(bounty.deadline)}
          {expired && <span className="pill pill-unfunded">Expired</span>}
        </dd>
        <dt>Created</dt>
        <dd>{formatDateTime(bounty.created_at)}</dd>
      </dl>

      <h2>About this bounty</h2>
      <ErrorBoundary label="bounty details" resetKey={`details:${bounty.id}`}>
        <CriteriaDetails key={bounty.id} bountyId={bounty.id} criteriaHash={bounty.criteria_hash} />
      </ErrorBoundary>

      <h2>Claim</h2>
      {closedReason ? (
        <p className="muted">{closedReason}</p>
      ) : (
        <ErrorBoundary label="claim form" resetKey={`claim:${bounty.id}`}>
          <ClaimFormV3
            key={bounty.id}
            bountyId={bounty.id}
            slots={bounty.slots}
            bountyExpired={expired}
            criteriaHash={bounty.criteria_hash}
          />
        </ErrorBoundary>
      )}

      <h2>Your claim</h2>
      <ErrorBoundary label="returning claim tracker" resetKey={`returning:${bounty.id}`}>
        <ReturningClaimTracker key={bounty.id} bountyId={bounty.id} slots={bounty.slots} />
      </ErrorBoundary>

      {/* Multi-slot bounties have no single voucher to show here; the
          settlement tracker appears after a claim is submitted above. */}
    </>
  );
}
