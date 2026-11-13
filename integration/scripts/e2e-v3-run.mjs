// e2e run: full scenarios A-F on a fresh in-process chain. Run from
// integration/ AFTER regenerating the fixture (see e2e:prepare):
//   npm run e2e
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import hre from "hardhat";
import {
  ROOT,
  OUTDIR,
  loadArtifact,
  loadFixture,
  assertChainSane,
  deploySuite,
  newTrace,
  setE2EBountyView,
  scenarioA,
  scenarioB,
  scenarioC,
  scenarioD,
  scenarioFrace,
  scenarioFretry,
  scenarioE,
} from "./e2e-v3-lib.mjs";

async function main() {
  const fx = loadFixture();
  const trace = newTrace(fx);
  mkdirSync(OUTDIR, { recursive: true });
  let storeN = 0;
  const tmpStore = (tag) => join(OUTDIR, `v3-e2e-${Date.now()}-${storeN++}-${tag}.json`);
  try {
    const provider = hre.ethers.provider;
    await assertChainSane(provider, fx);
    const [deployer, sponsor] = await hre.ethers.getSigners();
    const deployed = await deploySuite(deployer, fx.config.mpcSigner);
    if (deployed.token.toLowerCase() !== fx.config.token.toLowerCase()) {
      throw new Error("token address drift: redeploy order changed; regenerate via e2e:prepare");
    }
    if (deployed.escrow.toLowerCase() !== fx.config.escrow.toLowerCase()) {
      throw new Error("escrow address drift: redeploy order changed; regenerate via e2e:prepare");
    }
    console.log(`deployed mock USDC ${deployed.token}, escrow ${deployed.escrow} (match fixture)`);

    const escArt = loadArtifact("contracts/base-v3/out/OmniEscrowV2.sol/OmniEscrowV2.json");
    const escrow = new hre.ethers.Contract(deployed.escrow, escArt.abi, sponsor);
    const usdc = new hre.ethers.Contract(
      deployed.token,
      [
        "function mint(address to, uint256 amount)",
        "function balanceOf(address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
      ],
      provider
    );

    const slots = fx.bounty.slots.map(BigInt);
    const total = slots.reduce((a, b) => a + b, 0n);
    await (await usdc.connect(deployer).mint(sponsor.address, total)).wait();
    await (await usdc.connect(sponsor).approve(deployed.escrow, total)).wait();
    await (
      await escrow.createBounty(fx.bounty.bountyId, deployed.token, slots, fx.bounty.deadline, fx.bounty.criteriaHash)
    ).wait();
    await (await escrow.fundBounty(fx.bounty.bountyId)).wait();
    const escrowed = await usdc.balanceOf(deployed.escrow);
    if (escrowed.toString() !== total.toString()) throw new Error("funding mismatch");
    console.log(`bounty ${fx.bounty.bountyId} funded with ${total} (${slots.length} slots)`);
    setE2EBountyView(fx.bountyView);

    const relayEscrow = new hre.ethers.Contract(
      deployed.escrow,
      (await import("../../relayer/src/index.mjs")).ESCROW_ABI_V2,
      sponsor
    );
    const ctx = {
      fx,
      ethers: hre.ethers,
      provider,
      escrow: relayEscrow,
      escrowFull: escrow,
      usdc,
      sponsor,
      trace,
      tmpStore,
    };

    await scenarioA(ctx);
    await scenarioB(ctx);
    await scenarioC(ctx);
    await scenarioD(ctx);
    await scenarioFrace(ctx);
    await scenarioFretry(ctx);
    await scenarioE(ctx);

    const paid = [0, 1, 2, 3].reduce((a, i) => a + BigInt(fx.bounty.slots[i]), 0n);
    const refunded = BigInt(fx.bounty.slots[4]);
    const left = await usdc.balanceOf(deployed.escrow);
    if (paid + refunded + left !== total) throw new Error("conservation violated");
    console.log(`conservation ok: paid=${paid} refunded=${refunded} escrowed=${left} total=${total}`);

    trace.finishedAt = new Date().toISOString();
    trace.status = "pass";
  } catch (e) {
    trace.finishedAt = new Date().toISOString();
    trace.status = "FAIL";
    trace.error = String(e?.message ?? e);
    throw e;
  } finally {
    const out = join(OUTDIR, `v3-e2e-trace-${Date.now()}.json`);
    writeFileSync(out, JSON.stringify(trace, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log(`trace written to ${out}`);
  }

  console.log("");
  console.log("scenario  status  title");
  for (const s of trace.scenarios) {
    console.log(`${s.id.padEnd(9)} ${s.status.padEnd(6)} ${s.title}`);
  }
  if (trace.status !== "pass") process.exitCode = 1;
  else console.log("\nALL E2E SCENARIOS PASS");
}

try {
  await main();
  // Windows libuv teardown assertion workaround (see prepare script).
  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
} catch (e) {
  console.error(e?.stack ?? e);
  process.exit(1);
}
