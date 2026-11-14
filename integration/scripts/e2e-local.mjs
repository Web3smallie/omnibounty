// e2e:local — single-command local cross-chain E2E.
//
// Runs the complete lifecycle on a fresh in-process chain: dependency
// checks -> escrow build -> fixture regen (fresh deterministic clock) ->
// scenarios A-F -> verified report. No step is skipped silently: any
// failure prints what failed, why, and how to fix it, then exits 1.
// Replay mode (--no-regen) instead runs the committed frozen fixture
// plus the committed artifacts in testdata/evm/, invoking neither
// forge nor cargo.
//
// Time model: the fixture epoch is the single test clock. Regen runs
// inside this command (seconds before the scenarios), so the run can
// never go stale; E2E_FIXTURE_TIME pins the epoch for byte-reproducible
// fixtures (same inputs -> identical file, checkable with cmp).
// --no-regen runs testdata/v3/e2e-vouchers.json (frozen 2036 epoch);
// the harness pins the chain clock forward to that epoch at run time.
//
// This is a LOCAL simulation (in-process EVM, fixture NEAR views, test
// keys). It never touches live testnets and proves nothing about live
// cross-chain settlement. See JUDGES.md for the live runbook.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATION = join(HERE, "..");
const ROOT = join(HERE, "..", "..");
const OUT_FIXTURE = join(INTEGRATION, "out", "e2e-fx.json");
const ENV_JSON = join(INTEGRATION, "out", "e2e-env.json");
const FROZEN_FIXTURE = join(ROOT, "testdata", "v3", "e2e-vouchers.json");

const ok = (m) => console.log(`PASS: ${m}`);
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const step = (m) => console.log(`\n==> ${m}`);

function usage(exitCode) {
  console.log(`usage: npm run e2e:local [-- --no-regen]

Runs the full local cross-chain E2E: checks, escrow build, fixture regen,
scenarios A-F, verified report. Exits 0 only if every scenario passes.

  --no-regen   Replay mode: run the committed frozen fixture
               (${FROZEN_FIXTURE}) instead of regenerating. Invokes
               neither forge nor cargo: escrow artifacts resolve from
               testdata/evm/ (see PROVENANCE.md there) and the chain
               clock is pinned to the fixture epoch at run time.
  --help       This text.

Environment (all optional):
  E2E_FIXTURE_TIME   Pin the fixture epoch (unix seconds) for
                     byte-reproducible regen output.
`);
  process.exit(exitCode);
}

function have(cmd, args = ["--version"]) {
  try {
    const r = spawnSync(cmd, args, { stdio: "pipe" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function runLive(cmd, args, opts = {}) {
  // Stream stdio live AND capture it, so long steps show progress while
  // the orchestrator can still parse and report on the output.
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      process.stderr.write(d);
      out += d.toString();
    });
    child.on("error", (e) => resolve({ status: 127, out: out + String(e) }));
    child.on("close", (status) => resolve({ status: status ?? 1, out }));
  });
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) usage(0);
  const unknown = argv.filter((a) => a !== "--no-regen");
  if (unknown.length > 0) {
    console.error(`unknown flag(s): ${unknown.join(" ")}`);
    usage(2);
  }
  const noRegen = argv.includes("--no-regen");
  console.log(`e2e:local (mode: ${noRegen ? "frozen replay" : "fresh regen"})`);

  step("1/6 prerequisite commands");
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) fail(`node >= 22 required (found ${process.version})`);
  if (!have("npm")) fail("missing 'npm' (install Node.js >= 22 first)");
  for (const pkg of ["integration", "relayer"]) {
    // Relayer deps too: e2e imports relayer/src/*, whose `ethers` import
    // resolves via relayer/node_modules, not integration's.
    if (!existsSync(join(ROOT, pkg, "node_modules"))) {
      fail(`missing ${pkg}/node_modules (run: cd ${pkg} && npm ci)`);
    }
  }
  if (!noRegen) {
    if (!have("forge")) {
      fail("missing 'forge' (install Foundry: curl -sSL https://foundry.paradigm.xyz | bash, then foundryup)");
    }
    ok(`node ${process.version}, npm, integration deps, forge present`);
  } else {
    ok(`node ${process.version}, npm, integration deps present (replay mode: no forge/cargo needed)`);
  }
  if (!noRegen) {
    if (!have("cargo")) fail("missing 'cargo' (install rustup from https://rustup.rs, then re-run; or pass --no-regen)");
    const withRustup = have("rustup", ["toolchain", "list"]);
    if (withRustup) {
      const list = spawnSync("rustup", ["toolchain", "list"], { encoding: "utf8" });
      if (!/^stable/m.test(list.stdout ?? "")) {
        fail("rustup has no 'stable' toolchain (run: rustup toolchain install stable)");
      }
    } else {
      const v = spawnSync("rustc", ["--version"], { encoding: "utf8" });
      const m = /rustc 1\.(\d+)\./.exec(v.stdout ?? "");
      if (!m || Number(m[1]) < 88) fail("need rustc >= 1.88 without rustup (the lockfile requires it)");
    }
    ok("cargo + suitable Rust toolchain present");
  }

  step("2/6 escrow build artifacts");
  if (noRegen) {
    for (const f of ["testdata/evm/OmniEscrowV2.json", "testdata/evm/MockUSDC.json"]) {
      if (!existsSync(join(ROOT, f))) fail(`missing committed artifact ${f} (incomplete checkout?)`);
    }
    ok("using committed artifacts in testdata/evm/ (no forge invocation)");
  } else {
    const r = await runLive("forge", ["build"], { cwd: join(ROOT, "contracts", "base-v3") });
    if (r.status !== 0) fail("forge build failed (see output above)");
    ok("contracts/base-v3 artifacts built");
  }

  let fixturePath;
  if (noRegen) {
    step("3/6 fixture (frozen committed)");
    if (!existsSync(FROZEN_FIXTURE)) {
      fail(`missing committed fixture ${FROZEN_FIXTURE} (incomplete checkout?)`);
    }
    fixturePath = FROZEN_FIXTURE;
    ok(`replaying ${fixturePath} (frozen epoch; chain clock pinned at run time)`);
  } else {
    step("3/6 fixture addresses (prepare)");
    {
      const r = await runLive("npx", ["hardhat", "run", "--no-compile", "scripts/e2e-v3-prepare.mjs"], {
        cwd: INTEGRATION,
      });
      if (r.status !== 0) fail("e2e:prepare failed (see output above)");
    }
    let env;
    try {
      env = JSON.parse(readFileSync(ENV_JSON, "utf8"));
    } catch (e) {
      fail(`prepare did not write ${ENV_JSON} (${e.message})`);
    }
    ok(`escrow=${env.escrow} token=${env.token} chain=${env.chainId}`);

    step("4/6 fixture regen (fresh deterministic clock)");
    const cargoArgs = ["+stable", "test", "--locked", "--lib", "regen_e2e_fixture", "--", "--ignored", "--nocapture", "--exact", "tests::regen_e2e_fixture"];
    // Without rustup, `cargo +stable` cannot work; fall back to ambient cargo.
    const regenCmd = have("rustup", ["toolchain", "list"]) ? ["cargo", cargoArgs] : ["cargo", cargoArgs.slice(1)];
    const r = await runLive(regenCmd[0], regenCmd[1], {
      cwd: join(ROOT, "contracts", "near-v3"),
      env: {
        ...process.env,
        E2E_ESCROW_ADDRESS: env.escrow,
        E2E_TOKEN_ADDRESS: env.token,
        E2E_CHAIN_ID: String(env.chainId),
        E2E_OUT_PATH: OUT_FIXTURE,
      },
    });
    if (r.status !== 0) fail("fixture regen failed (see output above)");
    if (!existsSync(OUT_FIXTURE)) fail(`regen did not write ${OUT_FIXTURE}`);
    fixturePath = OUT_FIXTURE;
    const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
    ok(`fixture regenerated (generated_at=${fx.generated_at}, ${fx.claims.length} claims)`);
  }

  step(`${noRegen ? "4" : "5"}/6 scenarios A-F`);
  const run = await runLive(
    "npx",
    ["hardhat", "run", "--no-compile", "scripts/e2e-v3-run.mjs"],
    { cwd: INTEGRATION, env: { ...process.env, E2E_FIXTURE_PATH: fixturePath } }
  );

  step("report");
  const m = /trace written to (\S+\.json)/.exec(run.out);
  if (!m) fail("run produced no trace file (see output above)");
  const trace = JSON.parse(readFileSync(m[1], "utf8"));
  console.log("");
  console.log("scenario  status  title");
  for (const s of trace.scenarios) {
    console.log(`${String(s.id).padEnd(9)} ${String(s.status).padEnd(6)} ${s.title}`);
  }
  const passed = trace.scenarios.filter((s) => s.status === "pass").length;
  const total = trace.scenarios.length;
  console.log(`\nscenarios: ${passed}/${total} pass; trace: ${m[1]}`);
  console.log("LOCAL SIMULATION ONLY: in-process EVM + fixture NEAR views + test keys.");
  console.log("This proves the local lifecycle, NOT live NEAR-to-Base testnet settlement.");
  if (run.status !== 0 || trace.status !== "pass" || passed !== total) {
    fail(`E2E FAILED (${passed}/${total} scenarios pass)`);
  }
  console.log("\nE2E LOCAL: ALL GREEN");
}

await main(process.argv.slice(2));
