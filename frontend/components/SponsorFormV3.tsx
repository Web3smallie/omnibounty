"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { createBusyGuard, createSubmitGuard } from "../lib/submitGuard.mjs";
import {
  CREATE_BOUNTY_V3_DEPOSIT_YOCTO,
  CREATE_BOUNTY_V3_GAS,
  getBountyV3,
  getConfig,
  getSelector,
  listBounties,
  signAndSend,
} from "../lib/near";
import {
  ERC20_ABI,
  escrowBountyStateV2,
  escrowWithSignerV2,
  usdcAllowance,
  usdcBalanceOf,
} from "../lib/base";
import { buildCriteriaDocument, isV3ContractConfig, reconcileSponsorV3, runSponsorV3Flow, validateSponsorV3Form } from "../lib/sponsorV3.mjs";
import { waitForTxReceipt } from "../lib/txConfirm.mjs";
import { config } from "../lib/config";
import { useWallets } from "./wallets";
import { ExtLink, LoadingDots } from "./ui";
import { baseTxUrl, formatUsdc, nearTxUrl, shortenAddress } from "../lib/display.mjs";
import { shouldShowNearInitError } from "../lib/walletInit.mjs";

type StepState = { status: "idle" | "pending" | "done" | "error"; tx?: string; note?: string };

const STEP_LABELS = [
  "Register on NEAR",
  "Create on Base escrow",
  "Approve USDC",
  "Fund bounty",
  "Confirm funding on NEAR",
] as const;

const isNearStep = (i: number) => i === 0 || i === 4;

export default function SponsorFormV3() {
  const { nearAccount, connectNear, nearStatus, nearError, retryNear, evmAddress, evmOnBaseSepolia, connectEvm, switchEvmNetwork } =
    useWallets();
  const [bountyId, setBountyId] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  // Structured criteria fields (Simple mode). They compose the same JSON
  // document the Advanced editor takes, through the same validator.
  const [fTitle, setFTitle] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [fRepo, setFRepo] = useState("");
  const [fIssueUrl, setFIssueUrl] = useState("");
  const [fIssueKeywords, setFIssueKeywords] = useState("closes");
  const [fCloseRef, setFCloseRef] = useState(true);
  const [fSlots, setFSlots] = useState<string[]>([""]);
  const [fDeadline, setFDeadline] = useState("");
  const [fChallenge, setFChallenge] = useState("0");
  const [fMerge, setFMerge] = useState("merged");
  const [fForks, setFForks] = useState(true);
  const [fIdentity, setFIdentity] = useState("open");
  const built = buildCriteriaDocument({
    title: fTitle,
    description: fDescription,
    repo: fRepo,
    issueUrl: fIssueUrl,
    issueKeywords: fIssueKeywords,
    closeReference: fCloseRef,
    slotAmounts: fSlots,
    deadline: fDeadline,
    challengeWindowSec: fChallenge,
    mergePolicy: fMerge,
    allowForks: fForks,
    identityPolicy: fIdentity,
  }) as { ok: boolean; errors: string[]; json?: string };
  const effectiveCriteriaText = mode === "simple" ? (built.ok && built.json ? built.json : "") : criteriaText;
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [phase, setPhase] = useState<"edit" | "running" | "done">("edit");
  const [steps, setSteps] = useState<StepState[]>(STEP_LABELS.map(() => ({ status: "idle" })));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [ranFor, setRanFor] = useState<string | null>(null);
  const busyRef = useRef(createBusyGuard());
  const mountedRef = useRef(true);
  const liveRef = useRef({ nearAccount, evmAddress, evmOnBaseSepolia });
  liveRef.current = { nearAccount, evmAddress, evmOnBaseSepolia };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function setStep(i: number, s: StepState) {
    setSteps((prev) => prev.map((p, j) => (j === i ? s : p)));
  }

  async function suggestId() {
    setNote("");
    const current = bountyId;
    try {
      const list = await listBounties(0, 200);
      const max = list.reduce((m, b) => Math.max(m, b.id), -1);
      if (!mountedRef.current) return;
      // Only fill when the field is untouched: a slow response must not
      // clobber what the user typed meanwhile.
      setBountyId((prev) => (prev === current ? String(max + 1) : prev));
    } catch (e) {
      if (!mountedRef.current) return;
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
    setWarnings([]);
    setNote("");
    if (mode === "simple" && !built.ok) {
      setErrors(built.errors ?? ["Invalid input"]);
      return;
    }
    const v = validateSponsorV3Form({ bountyId, criteriaText: effectiveCriteriaText });
    if (!v.ok || !v.params) {
      setErrors(v.errors ?? ["Invalid input"]);
      return;
    }
    const params = v.params as {
      bountyId: number;
      criteriaJson: string;
      hash: string;
      slots: string[];
      total: string;
      deadline: string;
      title: string;
      repo: string;
      policy: string;
    };
    if (!busyRef.current.tryAcquire()) return; // double-submit: a run is already in progress
    setBusy(true);
    setPhase("running");

    // Step state belongs to one bounty+criteria pair: a changed form starts
    // over so a previous run's completions can never skip a fresh run.
    const runKey = `${params.bountyId}:${params.hash}`;
    const sameRun = ranFor === runKey;
    if (!sameRun) {
      setSteps(STEP_LABELS.map(() => ({ status: "idle" as const })));
      setRanFor(runKey);
    }

    // Preflight + resume reconciliation: read live state on both chains,
    // adopt already-complete steps, and block on anything inconsistent.
    // Nothing is submitted until every step below is verified in order.
    // The escrow read is NOT null-tolerated: a version mismatch or RPC
    // failure must fail loudly instead of proceeding blind.
    try {
      setNote("Preflight: checking wallets, contract state, and USDC balance…");
      const cfg = await getConfig();
      const contractIsV3 = isV3ContractConfig(cfg);
      const [near, escrow, allowance, balance] = await Promise.all([
        getBountyV3(params.bountyId),
        escrowBountyStateV2(params.bountyId),
        evmAddress ? usdcAllowance(evmAddress, config.escrowAddress).catch(() => null) : null,
        evmAddress ? usdcBalanceOf(evmAddress).catch(() => null) : null,
      ]);
      if (!mountedRef.current) return;
      const rec = reconcileSponsorV3({
        params,
        wallets: { nearAccount, evmAddress, evmOnBaseSepolia },
        contractIsV3,
        paused: cfg.paused === true,
        near,
        escrow,
        allowance: allowance as bigint | null,
        balance: balance as bigint | null,
      });
      if (rec.warnings.length > 0) setWarnings(rec.warnings);
      if (rec.blockers.length > 0) {
        setErrors(rec.blockers);
        setBusy(false);
        setPhase("edit");
        setNote("");
        return;
      }
      rec.adopted.forEach((done, i) => {
        if (done) setStep(i, { status: "done" });
      });
      if (rec.adopted.every(Boolean)) {
        setNote("");
        setPhase("done");
        setBusy(false);
        return;
      }

      const selector = await getSelector();
      if (!mountedRef.current) return;
      // Wallet/chain snapshot: every write below re-checks it first, so an
      // account or network swap mid-run aborts into resume instead of
      // signing from the wrong context.
      const guard = createSubmitGuard({ nearAccount, evmAddress, evmOnBaseSepolia });
      const liveWallets = () => ({
        nearAccount: liveRef.current.nearAccount,
        evmAddress: liveRef.current.evmAddress,
        evmOnBaseSepolia: liveRef.current.evmOnBaseSepolia,
      });
      const guarded = <A extends unknown[], R>(fn: (...a: A) => Promise<R>): ((...a: A) => Promise<R>) => {
        return (...a: A) => {
          guard.assertUnchanged(liveWallets());
          return fn(...a);
        };
      };
      const io = {
        createNear: async (args: { bounty_id: number; token: string; criteria_json: string }) => {
          const r = await signAndSend(
            selector,
            "create_bounty",
            args as unknown as Record<string, unknown>,
            CREATE_BOUNTY_V3_DEPOSIT_YOCTO,
            CREATE_BOUNTY_V3_GAS
          );
          return { txHash: r.txHash };
        },
        getNear: (id: number) => getBountyV3(id),
        createEscrow: async (a: {
          bountyId: number;
          token: string;
          amounts: string[];
          deadline: string;
          criteriaHash: string;
        }) => {
          const esc = (await escrowWithSignerV2()) as unknown as {
            createBounty(
              id: number,
              token: string,
              amounts: string[],
              deadline: bigint,
              criteriaHash: string
            ): Promise<ethers.TransactionResponse>;
          };
          const tx = await esc.createBounty(a.bountyId, a.token, a.amounts, BigInt(a.deadline), a.criteriaHash);
          const receipt = await waitForTxReceipt(tx);
          return { txHash: tx.hash, receipt: { status: receipt?.status } };
        },
        approveUSDC: async (total: string) => {
          const signer = (await escrowWithSignerV2()).runner as ethers.Signer;
          const usdc = new ethers.Contract(config.usdcAddress, ERC20_ABI, signer) as unknown as {
            approve(sp: string, amt: bigint): Promise<ethers.TransactionResponse>;
          };
          const tx = await usdc.approve(config.escrowAddress, BigInt(total));
          const receipt = await waitForTxReceipt(tx);
          return { txHash: tx.hash, receipt: { status: receipt?.status } };
        },
        getAllowance: () => usdcAllowance(evmAddress as string, config.escrowAddress),
        fundEscrow: async (id: number) => {
          const esc = (await escrowWithSignerV2()) as unknown as {
            fundBounty(id: number): Promise<ethers.TransactionResponse>;
          };
          const tx = await esc.fundBounty(id);
          const receipt = await waitForTxReceipt(tx);
          return { txHash: tx.hash, receipt: { status: receipt?.status } };
        },
        getEscrow: (id: number) => escrowBountyStateV2(id),
        markFunded: async (id: number) => {
          const r = await signAndSend(selector, "mark_funded", { bounty_id: id });
          return { txHash: r.txHash };
        },
      };
      const guardedIo = {
        ...io,
        createNear: guarded(io.createNear),
        createEscrow: guarded(io.createEscrow),
        approveUSDC: guarded(io.approveUSDC),
        fundEscrow: guarded(io.fundEscrow),
        markFunded: guarded(io.markFunded),
      };
      const out = await runSponsorV3Flow({
        params,
        token: config.usdcAddress,
        adopted: rec.adopted.map((a, i) => a || (sameRun && steps[i].status === "done")),
        io: guardedIo,
        onStep: (i: number, s: { status: StepState["status"]; tx?: string | null; note?: string }) =>
          setStep(i, { status: s.status, tx: s.tx ?? undefined, note: s.note }),
      });
      if (!mountedRef.current) return;
      if (!out.ok) {
        setErrors([
          `${out.message} — completed steps are kept; fix the problem and press “Resume” to continue from the failed step.`,
        ]);
        setBusy(false);
        setPhase("running");
        setNote("");
        return;
      }
      setPhase("done");
      setNote("");
    } catch (e) {
      if (!mountedRef.current) return;
      setErrors([e instanceof Error ? e.message : String(e)]);
      setBusy(false);
      setPhase("running");
      setNote("");
      return;
    } finally {
      busyRef.current.release();
      if (mountedRef.current) setBusy(false);
    }
  }

  const preview = validateSponsorV3Form({ bountyId, criteriaText: effectiveCriteriaText });
  const previewParams = (preview.ok && preview.params ? preview.params : null) as {
    bountyId: number;
    criteriaJson: string;
    hash: string;
    slots: string[];
    total: string;
    deadline: string;
    title: string;
    description: string;
    repo: string;
    policy: string;
  } | null;

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
                placeholder="e.g. 223339065907693"
              />
            </label>
            <button type="button" className="suggest" onClick={() => void suggestId()}>
              Suggest next
            </button>
          </div>
          <div className="filters" role="group" aria-label="Criteria input mode">
            {(["simple", "advanced"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? "filter filter-on" : "filter"}
                onClick={() => {
                  if (m === "advanced" && built.ok && built.json) setCriteriaText(built.json);
                  setMode(m);
                }}
                aria-pressed={mode === m}
              >
                {m === "simple" ? "Simple" : "Advanced JSON"}
              </button>
            ))}
          </div>
          <p className="muted small">
            The acceptance-criteria document describes the work and how a winning pull request is
            recognized. Its hash is committed on NEAR and the slot schedule is funded with USDC.
            Simple mode builds it from the fields below; Advanced mode edits the JSON directly
            (for custom checks, file, label, or reviewer constraints).
          </p>
          {mode === "simple" ? (
            <>
              <label className="field">
                Title
                <span className="hint">Short contributor-facing headline, e.g. “Fix the login redirect loop”.</span>
                <input
                  type="text"
                  value={fTitle}
                  onChange={(e) => setFTitle(e.target.value)}
                  placeholder="e.g. Fix the login redirect loop"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                Description
                <span className="hint">
                  What to do, what to deliver, and how it is judged. Contributors read this before
                  attempting the work.
                </span>
                <textarea
                  value={fDescription}
                  onChange={(e) => setFDescription(e.target.value)}
                  placeholder="e.g. Diagnose why /login redirects authenticated users back to itself, land a merged PR with a regression test, and reference the issue below so it closes."
                  spellCheck={false}
                />
              </label>
              <label className="field">
                GitHub repository
                <span className="hint">The repo the winning pull request must belong to.</span>
                <input
                  type="text"
                  value={fRepo}
                  onChange={(e) => setFRepo(e.target.value)}
                  placeholder="owner/name"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                Issue URL (optional)
                <span className="hint">
                  The GitHub issue or pull this bounty resolves, e.g.
                  https://github.com/owner/name/issues/123. Must belong to the repository above.
                </span>
                <input
                  type="text"
                  value={fIssueUrl}
                  onChange={(e) => setFIssueUrl(e.target.value)}
                  placeholder="https://github.com/owner/name/issues/123"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {fIssueUrl.trim() !== "" && (
                <div className="field-row">
                  <label className="field grow">
                    Issue keywords
                    <span className="hint">Comma-separated, e.g. closes, fixes.</span>
                    <input
                      type="text"
                      value={fIssueKeywords}
                      onChange={(e) => setFIssueKeywords(e.target.value)}
                      placeholder="closes"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    Close reference
                    <span className="hint">PR body must reference the issue.</span>
                    <input
                      type="checkbox"
                      checked={fCloseRef}
                      onChange={(e) => setFCloseRef(e.target.checked)}
                    />
                  </label>
                </div>
              )}
              <div className="field">
                <span>Reward slots (USDC each)</span>
                <span className="hint">
                  One slot pays a single winner; several slots pay several winners in order. Human
                  units, up to 6 decimals.
                </span>
                {fSlots.map((amt, i) => (
                  <div className="field-row" key={i}>
                    <input
                      className="grow"
                      type="text"
                      value={amt}
                      onChange={(e) =>
                        setFSlots((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
                      }
                      placeholder={`Slot #${i} USDC, e.g. 25.50`}
                      aria-label={`Slot #${i} amount in USDC`}
                      inputMode="decimal"
                      autoComplete="off"
                    />
                    {fSlots.length > 1 && (
                      <button
                        type="button"
                        className="suggest"
                        onClick={() => setFSlots((prev) => prev.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                {fSlots.length < 16 && (
                  <button type="button" className="suggest" onClick={() => setFSlots((prev) => [...prev, ""])}>
                    Add slot
                  </button>
                )}
              </div>
              <div className="field-row">
                <label className="field grow">
                  Deadline (optional)
                  <span className="hint">Claims after this time are rejected. Empty means none.</span>
                  <input type="datetime-local" value={fDeadline} onChange={(e) => setFDeadline(e.target.value)} />
                </label>
                <label className="field">
                  Challenge window (seconds)
                  <span className="hint">0 finalizes immediately (demo); production bounties allow challenge time.</span>
                  <input
                    type="text"
                    value={fChallenge}
                    onChange={(e) => setFChallenge(e.target.value)}
                    placeholder="0"
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  Merge policy
                  <span className="hint">How the winning PR qualifies.</span>
                  <select value={fMerge} onChange={(e) => setFMerge(e.target.value)}>
                    <option value="merged">merged</option>
                    <option value="ci_verified">ci_verified</option>
                  </select>
                </label>
                <label className="field">
                  Identity policy
                  <span className="hint">Who may claim.</span>
                  <select value={fIdentity} onChange={(e) => setFIdentity(e.target.value)}>
                    <option value="open">open</option>
                    <option value="commitment">commitment</option>
                  </select>
                </label>
                <label className="field">
                  Allow forks
                  <span className="hint">PRs from forked repos accepted.</span>
                  <input type="checkbox" checked={fForks} onChange={(e) => setFForks(e.target.checked)} />
                </label>
              </div>
            </>
          ) : (
            <label className="field">
              Criteria JSON
              <span className="hint">
                The full acceptance-criteria document, including any custom checks, file, label, or
                reviewer constraints. Validated locally; its hash is committed on NEAR and the slot
                schedule is funded with USDC.
              </span>
              <textarea
                value={criteriaText}
                onChange={(e) => setCriteriaText(e.target.value)}
                placeholder='{"schema": "omnibounty/criteria", …}'
                spellCheck={false}
              />
            </label>
          )}

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

          {shouldShowNearInitError(nearStatus, nearAccount) && (
            <div className="notice error" role="alert">
              NEAR wallet setup failed: {nearError}{" "}
              <button type="button" onClick={retryNear}>
                Retry setup
              </button>
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
        {warnings.length > 0 && (
          <div className="notice warn" role="status">
            {warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}
        {errors.length > 0 && (
          <ul className="errors" id="sponsor-errors" role="alert">
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
                  <ExtLink
                    href={
                      isNearStep(i)
                        ? nearTxUrl(config.networkId, steps[i].tx!)
                        : baseTxUrl(steps[i].tx!)
                    }
                  >
                    <code>{steps[i].tx!.slice(0, 18)}… ↗</code>
                  </ExtLink>
                )}
                {steps[i].status === "pending" && <span className="muted small">{steps[i].note ?? "Working…"}</span>}
                {steps[i].status === "pending" && steps[i].tx && !isNearStep(i) && (
                  <ExtLink href={baseTxUrl(steps[i].tx!)}>
                    <code>{steps[i].tx!.slice(0, 18)}… ↗</code>
                  </ExtLink>
                )}
                {steps[i].status === "error" && <span className="muted small">Failed — see error above.</span>}
                {steps[i].status === "error" && steps[i].tx && (
                  <ExtLink
                    href={
                      isNearStep(i)
                        ? nearTxUrl(config.networkId, steps[i].tx!)
                        : baseTxUrl(steps[i].tx!)
                    }
                  >
                    <code>{steps[i].tx!.slice(0, 18)}… ↗</code>
                  </ExtLink>
                )}
              </li>
            ))}
          </ol>
        )}
        {phase === "done" && (
          <div className="notice ok" role="status">
            <strong>
              Bounty #{bountyId} is open and funded with {formatUsdc(previewParams?.total ?? "0")} USDC.
            </strong>{" "}
            <a href={`/bounties/${bountyId}`}>Open the bounty page →</a>
          </div>
        )}
      </div>

      <aside className="preview card">
        <h3>Listing preview</h3>
        {previewParams ? (
          <>
            <div className="bounty-title">{previewParams.title}</div>
            <div className="bounty-amount">{formatUsdc(previewParams.total)} USDC</div>
            <p className="muted small">
              {previewParams.description.length > 220
                ? `${previewParams.description.slice(0, 220)}…`
                : previewParams.description}
            </p>
            <dl className="facts">
              <dt>Bounty ID</dt>
              <dd className="mono">#{previewParams.bountyId}</dd>
              <dt>Repo</dt>
              <dd className="mono">{previewParams.repo}</dd>
              <dt>Slots</dt>
              <dd className="mono">
                {previewParams.slots.map((a, i) => (
                  <span key={i}>
                    {i > 0 && " · "}#{i}: {formatUsdc(a)}
                  </span>
                ))}
              </dd>
              <dt>Criteria hash</dt>
              <dd className="mono small" title={previewParams.hash}>
                {shortenAddress(previewParams.hash)}
              </dd>
              <dt>Token</dt>
              <dd className="mono small">{config.usdcAddress}</dd>
            </dl>
          </>
        ) : (
          <p className="muted small">
            Paste criteria JSON to preview the bounty: slot schedule, funding total, and the
            criteria hash that will be committed on NEAR.
          </p>
        )}
      </aside>
    </div>
  );
}
