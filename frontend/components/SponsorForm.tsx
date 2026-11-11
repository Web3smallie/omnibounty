"use client";

import { useState } from "react";
import { ethers } from "ethers";
import { validateSponsorForm } from "../lib/validation.mjs";
import { getBounty, getConfig, getSelector, listBounties, signAndSend } from "../lib/near";
import { ERC20_ABI, escrowBountyState, escrowWithSigner, usdcBalanceOf } from "../lib/base";
import { config } from "../lib/config";
import { useWallets } from "./wallets";
import { ExtLink, LoadingDots } from "./ui";
import { baseTxUrl, formatExpiry, formatUsdc, nearTxUrl } from "../lib/display.mjs";

type StepState = { status: "idle" | "pending" | "done" | "error"; tx?: string; note?: string };

const STEP_LABELS = [
  "Register on NEAR",
  "Create on Base escrow",
  "Approve USDC",
  "Fund bounty",
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

export default function SponsorForm() {
  const { nearAccount, connectNear, evmAddress, evmOnBaseSepolia, connectEvm, switchEvmNetwork } =
    useWallets();
  const [bountyId, setBountyId] = useState("");
  const [repo, setRepo] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [amountUsdc, setAmountUsdc] = useState("");
  const [deadline, setDeadline] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [phase, setPhase] = useState<"edit" | "running" | "done">("edit");
  const [steps, setSteps] = useState<StepState[]>(STEP_LABELS.map(() => ({ status: "idle" })));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  function setStep(i: number, s: StepState) {
    setSteps((prev) => prev.map((p, j) => (j === i ? s : p)));
  }

  async function suggestId() {
    setNote("");
    try {
      const list = await listBounties(0, 200);
      const max = list.reduce((m, b) => Math.max(m, b.id), -1);
      setBountyId(String(max + 1));
    } catch (e) {
      setErrors([`Could not read existing bounties: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }

  function fail(message: string) {
    setErrors([message]);
    setBusy(false);
    setPhase("edit");
  }

  async function run() {
    setErrors([]);
    setNote("");
    const v = validateSponsorForm({ bountyId, repo, prNumber, amountUsdc, deadline });
    if (!v.ok || !v.params) {
      setErrors(v.errors ?? ["Invalid input"]);
      return;
    }
    const params = v.params as {
      bounty_id: number;
      repo: string;
      pr_number: number;
      amount: string;
      expiry: number;
    };
    if (!nearAccount) return fail("Connect your NEAR wallet first — the bounty template is registered from that account.");
    if (!evmAddress) return fail("Connect your EVM wallet first — funding happens from that account on Base Sepolia.");
    if (evmOnBaseSepolia !== true) return fail("Your EVM wallet is on the wrong network. Switch to Base Sepolia and retry.");
    setBusy(true);
    setPhase("running");

    // Preflight: fail fast before any transaction.
    try {
      setNote("Preflight: checking contract state, bounty ID, and USDC balance…");
      const cfg = await getConfig();
      if (cfg.paused) return fail("The NEAR contract is paused. Bounty creation is disabled right now.");
      const existing = await getBounty(params.bounty_id);
      if (existing) return fail(`Bounty #${params.bounty_id} already exists on NEAR. Pick another ID.`);
      const onBase = await escrowBountyState(params.bounty_id);
      if (onBase.sponsor !== ZERO) {
        return fail(`Bounty #${params.bounty_id} is already taken on the Base escrow. Pick another ID.`);
      }
      const balance = await usdcBalanceOf(evmAddress);
      if (balance < BigInt(params.amount)) {
        return fail(
          `Insufficient USDC: your wallet holds ${formatUsdc(balance.toString())} USDC but the bounty needs ${formatUsdc(params.amount)} USDC.`
        );
      }
    } catch (e) {
      // Always surface preflight failures (never condition on stale render state).
      setErrors([e instanceof Error ? e.message : String(e)]);
      setBusy(false);
      setPhase("edit");
      return;
    }

    // Step 1: NEAR create_bounty.
    let firstPending = steps.findIndex((s) => s.status !== "done");
    if (firstPending === -1) {
      // All steps done (e.g. user pressed submit again): start a fresh run
      // instead of re-entering step guards that assume an unfinished flow.
      setSteps(STEP_LABELS.map(() => ({ status: "idle" as const })));
      firstPending = 0;
    }
    try {
      if (firstPending <= 0) {
        setStep(0, { status: "pending", note: "Confirm in your NEAR wallet…" });
        const selector = await getSelector();
        const receipt = await signAndSend(selector, "create_bounty", {
          bounty_id: params.bounty_id,
          repo: params.repo,
          pr_number: params.pr_number,
          token: config.usdcAddress,
          amount: params.amount,
          expiry: params.expiry,
        });
        setStep(0, { status: "done", tx: receipt.txHash ?? undefined });
      }
      setNote("NEAR registration confirmed. Continuing on Base…");
      const escrow = await escrowWithSigner();
      const signer = escrow.runner as ethers.Signer;
      const usdc = new ethers.Contract(config.usdcAddress, ERC20_ABI, signer);
      const esc = escrow as unknown as {
        createBounty(id: number, token: string, amount: bigint): Promise<ethers.TransactionResponse>;
        fundBounty(id: number): Promise<ethers.TransactionResponse>;
      };
      if (firstPending <= 1) {
        setStep(1, { status: "pending", note: "Confirm in your EVM wallet…" });
        const tx = await esc.createBounty(params.bounty_id, config.usdcAddress, BigInt(params.amount));
        setStep(1, { status: "pending", tx: tx.hash, note: "Confirming…" });
        await tx.wait();
        setStep(1, { status: "done", tx: tx.hash });
      }
      if (firstPending <= 2) {
        setStep(2, { status: "pending", note: "Confirm in your EVM wallet…" });
        const approve = (usdc as unknown as {
          approve(sp: string, amt: bigint): Promise<ethers.TransactionResponse>;
        }).approve(config.escrowAddress, BigInt(params.amount));
        const tx = await approve;
        setStep(2, { status: "pending", tx: tx.hash, note: "Confirming…" });
        await tx.wait();
        setStep(2, { status: "done", tx: tx.hash });
      }
      setStep(3, { status: "pending", note: "Confirm in your EVM wallet…" });
      const fundTx = await esc.fundBounty(params.bounty_id);
      setStep(3, { status: "pending", tx: fundTx.hash, note: "Confirming…" });
      await fundTx.wait();
      setStep(3, { status: "done", tx: fundTx.hash });
      setPhase("done");
      setNote("");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSteps((prev) => prev.map((s) => (s.status === "pending" ? { ...s, status: "error", note: message } : s)));
      setErrors([
        `${message} — completed steps are kept; fix the problem and press “Resume” to continue from the failed step.`,
      ]);
    } finally {
      setBusy(false);
    }
  }

  const preview = validateSponsorForm({ bountyId, repo, prNumber, amountUsdc, deadline });
  const previewParams = (
    preview.ok && preview.params
      ? preview.params
      : null
  ) as { bounty_id: number; repo: string; pr_number: number; amount: string; expiry: number } | null;

  return (
    <div className="sponsor-layout">
      <div>
        <form
          className="stacked"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="field-row">
            <label className="field grow">
              Bounty ID
              <span className="hint">One number shared by NEAR and Base. Must be unused on both.</span>
              <input
                type="number"
                min={0}
                value={bountyId}
                onChange={(e) => setBountyId(e.target.value)}
                placeholder="e.g. 5"
              />
            </label>
            <button type="button" className="suggest" onClick={() => void suggestId()}>
              Suggest next
            </button>
          </div>
          <label className="field">
            GitHub repository
            <span className="hint">The repo the winning pull request must belong to.</span>
            <input
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            Pull request number
            <span className="hint">Only this exact PR can claim the bounty, once merged.</span>
            <input
              type="number"
              min={1}
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              placeholder="e.g. 38132"
            />
          </label>
          <label className="field">
            Reward (USDC)
            <span className="hint">
              Human units, up to 6 decimals. Paid on Base Sepolia from your connected EVM wallet.
            </span>
            <input
              type="text"
              value={amountUsdc}
              onChange={(e) => setAmountUsdc(e.target.value)}
              placeholder="e.g. 25.50"
              inputMode="decimal"
              autoComplete="off"
            />
          </label>
          <label className="field">
            Deadline (optional)
            <span className="hint">Claims after this time are rejected. Empty means no deadline.</span>
            <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>

          {(!nearAccount || !evmAddress || evmOnBaseSepolia !== true) && phase !== "done" && (
            <div className="notice warn">
              {!nearAccount && (
                <div>
                  <button type="button" onClick={connectNear}>
                    Connect NEAR wallet
                  </button>{" "}
                  <span className="muted small">to register the bounty template.</span>
                </div>
              )}
              {!evmAddress && (
                <div>
                  <button type="button" onClick={() => void connectEvm()}>
                    Connect EVM wallet
                  </button>{" "}
                  <span className="muted small">to fund the bounty with USDC.</span>
                </div>
              )}
              {evmAddress && evmOnBaseSepolia !== true && (
                <div>
                  <button type="button" onClick={() => void switchEvmNetwork()}>
                    Switch to Base Sepolia
                  </button>{" "}
                  <span className="muted small">Your EVM wallet is on the wrong network.</span>
                </div>
              )}
            </div>
          )}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Working…" : phase === "running" ? "Resume creation" : "Create and fund bounty"}
          </button>
        </form>

        {note && (
          <div className="notice">
            <LoadingDots label={note} />
          </div>
        )}
        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        {(phase === "running" || phase === "done") && (
          <ol className="steps">
            {STEP_LABELS.map((label, i) => (
              <li key={label} className={`step step-${steps[i].status}`}>
                <span className="step-label">{label}</span>
                {steps[i].status === "done" && steps[i].tx && (
                  <ExtLink href={i === 0 ? nearTxUrl(config.networkId, steps[i].tx!) : baseTxUrl(steps[i].tx!)}>
                    <code>{steps[i].tx!.slice(0, 18)}… ↗</code>
                  </ExtLink>
                )}
                {steps[i].status === "pending" && <span className="muted small">{steps[i].note ?? "Working…"}</span>}
                {steps[i].status === "pending" && steps[i].tx && (
                  <ExtLink href={baseTxUrl(steps[i].tx!)}>
                    <code>{steps[i].tx!.slice(0, 18)}… ↗</code>
                  </ExtLink>
                )}
                {steps[i].status === "error" && <span className="muted small">Failed — see error above.</span>}
              </li>
            ))}
          </ol>
        )}
        {phase === "done" && (
          <div className="notice ok">
            <strong>
              Bounty #{bountyId} is open and funded with {formatUsdc(previewParams?.amount ?? "0")} USDC.
            </strong>{" "}
            <a href={`/bounties/${bountyId}`}>Open the bounty page →</a>
          </div>
        )}
      </div>

      <aside className="preview card">
        <h3>Listing preview</h3>
        {previewParams ? (
          <>
            <div className="bounty-title">
              {previewParams.repo}#{previewParams.pr_number}
            </div>
            <div className="bounty-amount">{formatUsdc(previewParams.amount)} USDC</div>
            <dl className="facts">
              <dt>Bounty ID</dt>
              <dd className="mono">#{previewParams.bounty_id}</dd>
              <dt>Criteria</dt>
              <dd>
                PR {previewParams.repo}#{previewParams.pr_number} must be merged; the merge is
                proven with Reclaim zkTLS.
              </dd>
              <dt>Deadline</dt>
              <dd>{formatExpiry(previewParams.expiry)}</dd>
              <dt>Token</dt>
              <dd className="mono small">{config.usdcAddress}</dd>
            </dl>
          </>
        ) : (
          <p className="muted small">
            Fill in the form to preview the marketplace listing. The on-chain template stores the
            repository, PR number, amount, and deadline — the title is derived from them.
          </p>
        )}
      </aside>
    </div>
  );
}
