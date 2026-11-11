import { getConfig, listBounties } from "../lib/near";
import { config } from "../lib/config";
import Marketplace from "../components/Marketplace";
import { ExtLink } from "../components/ui";
import { baseAddressUrl, formatUsdc, nearAccountUrl, shortenAddress } from "../lib/display.mjs";

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
  const paidOut =
    bounties
      ?.filter((b) => b.status === "claimed")
      .reduce((sum, b) => sum + BigInt(b.amount), 0n) ?? 0n;

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>
            Get paid in USDC for <em>merged</em> pull requests.
          </h1>
          <p className="lede">
            Sponsors fund bounties on Base Sepolia. Contributors prove the merge with Reclaim
            zkTLS, a NEAR contract verifies the proof, and an MPC-signed voucher releases the
            payout — no judges, no manual review.
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
