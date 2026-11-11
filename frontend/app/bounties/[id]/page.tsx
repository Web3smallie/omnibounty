import { getBounty, getConfig, getVoucher } from "../../../lib/near";
import { config } from "../../../lib/config";
import ClaimForm from "../../../components/ClaimForm";
import SettlementPanel from "../../../components/SettlementPanel";
import { ExtLink, StatusPill } from "../../../components/ui";
import EscrowState from "../../../components/EscrowState";
import {
  baseAddressUrl,
  bountyCriteria,
  bountyTitle,
  formatDateTime,
  formatExpiry,
  formatUsdc,
  githubPrUrl,
  nearAccountUrl,
} from "../../../lib/display.mjs";

export const dynamic = "force-dynamic";

export default async function BountyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bountyId = Number(id);
  if (!Number.isInteger(bountyId) || bountyId < 0) {
    return <div className="notice error">Invalid bounty id.</div>;
  }
  let bounty = null;
  let voucher = null;
  let voucherTtlSec = 86400;
  let error: string | null = null;
  try {
    bounty = await getBounty(bountyId);
    voucher = await getVoucher(bountyId);
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
            <EscrowState bountyId={bounty.id} />
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
        <ClaimForm
          bountyId={bounty.id}
          bountyRepo={bounty.repo}
          bountyPrNumber={bounty.pr_number}
          bountyExpired={expired}
        />
      )}

      {(voucher || bounty.status !== "open") && (
        <>
          <h2>Voucher &amp; settlement</h2>
          <SettlementPanel
            bountyId={bounty.id}
            initialVoucher={voucher}
            watch={true}
            voucherTtlSec={voucherTtlSec}
          />
        </>
      )}
    </>
  );
}
