import { getConfig, listBounties } from "../lib/near";
import { escrowV2PaidTotal } from "../lib/base";
import { config } from "../lib/config";
import Marketplace from "../components/Marketplace";
import { ExtLink } from "../components/ui";
import { aggregateV3Paid, baseAddressUrl, claimedAmountsTotal, formatUsdc, nearAccountUrl, shortenAddress } from "../lib/display.mjs";

export const dynamic = "force-dynamic";

export default async function Home() {
  let bounties = null;
  let protocol: {
    paused: boolean;
    mpc_signer: string | null;
    escrow: string;
    chain_id: number;
  } | null = null;
  let error: string | null = null;
  try {
    const [list, cfg] = await Promise.all([listBounties(0, 200), getConfig()]);
    bounties = list;
    protocol = cfg;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const open = bounties?.filter((b) => b.status === "open").length ?? 0;
  // Safe on mixed V1/V3 lists: V3 records carry total_amount (not the
  // claimed part) and non-"claimed" statuses, and malformed amounts are
  // skipped instead of throwing outside the load try/catch above.
  const paidOutV1 = claimedAmountsTotal(bounties ?? []);
  // V3: only escrow-settled slots count (claimedBitmap bits set atomically
  // with the USDC transfer). Failed reads flag `incomplete` so the page
  // warns instead of silently understating the total.
  const v3 = await aggregateV3Paid(bounties ?? [], (id: number) => escrowV2PaidTotal(id));
  const paidOut = paidOutV1 + v3.total;

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>Verifiable work. Deterministic rewards. Cross-chain settlement.</h1>
          <p className="lede">
            NEAR-based cross-chain bounties. Sponsors commit cryptographic acceptance criteria on
            NEAR and fund USDC rewards on Base. Contributors prove their GitHub identity and merged
            pull requests using Reclaim zkTLS. NEAR verifies each claim, an MPC signer authorizes
            the payout, and the Base escrow independently verifies and settles the reward.
          </p>
        </div>
        <div className="journeys">
          <a className="journey" href="/bounties/new">
            <span className="journey-kicker">For sponsors</span>
            <span className="journey-title">Fund a bounty</span>
            <span className="journey-text">
              Pick a repo and PR, set the reward and deadline, fund it with USDC.
            </span>
            <span className="journey-cta">Create a bounty →</span>
          </a>
          <a className="journey" href="#browse">
            <span className="journey-kicker">For contributors</span>
            <span className="journey-title">Claim a bounty</span>
            <span className="journey-text">
              Merge the PR, paste your Reclaim proof, and watch the USDC land.
            </span>
            <span className="journey-cta">Browse bounties →</span>
          </a>
        </div>
      </section>

      {error ? (
        <div className="notice error">
          Could not load bounties from the NEAR contract: <code>{error}</code>
        </div>
      ) : (
        <>
          <section className="stats">
            <div className="stat">
              <span className="stat-num">{bounties!.length}</span>
              <span className="stat-label">bounties on-chain</span>
            </div>
            <div className="stat">
              <span className="stat-num">{open}</span>
              <span className="stat-label">open now</span>
            </div>
            <div className="stat">
              <span className="stat-num">{formatUsdc(paidOut.toString())}</span>
              <span className="stat-label">USDC claimed by contributors</span>
            </div>
          </section>
          {v3.incomplete ? (
            <div className="notice warn">
              Some V3 payout data is temporarily unavailable; the claimed total may be understated.
            </div>
          ) : null}
          <Marketplace bounties={bounties!} />
        </>
      )}

      <section className="protocol card">
        <h2>Live protocol</h2>
        {protocol ? (
          <dl className="facts">
            <dt>NEAR contract</dt>
            <dd className="mono">
              <ExtLink href={nearAccountUrl(config.networkId, config.contractId)}>
                {config.contractId} ↗
              </ExtLink>
            </dd>
            <dt>Base escrow</dt>
            <dd className="mono">
              <ExtLink href={baseAddressUrl(config.escrowAddress)}>
                {shortenAddress(config.escrowAddress)} ↗
              </ExtLink>
            </dd>
            <dt>MPC signer</dt>
            <dd className="mono">
              {protocol.mpc_signer ? (
                <ExtLink href={baseAddressUrl(protocol.mpc_signer)}>
                  {shortenAddress(protocol.mpc_signer)} ↗
                </ExtLink>
              ) : (
                "not configured"
              )}
            </dd>
            <dt>Chain</dt>
            <dd className="mono">Base Sepolia ({protocol.chain_id})</dd>
            <dt>Status</dt>
            <dd>{protocol.paused ? "Paused" : "Live"}</dd>
          </dl>
        ) : (
          <p className="muted">Protocol configuration is unreachable right now.</p>
        )}
        <ol className="how">
          <li>
            <strong>Sponsor funds</strong> — USDC locks in the Base escrow; the bounty template
            registers on NEAR.
          </li>
          <li>
            <strong>Contributor proves</strong> — a Reclaim zkTLS proof of the merged PR is
            submitted to NEAR.
          </li>
          <li>
            <strong>Contract verifies, MPC signs</strong> — the proof is checked on-chain and a
            payout voucher is signed via Chain Signatures.
          </li>
          <li>
            <strong>Relayer settles</strong> — the voucher is submitted to Base; USDC goes to the
            proof owner.
          </li>
        </ol>
      </section>
    </>
  );
}
