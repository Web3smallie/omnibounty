import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// V3-only frontend: no V1 creation path is reachable, every run targets
// the deployed V3 contracts, and contributor-facing bounty details render
// from hash-verified criteria. Static pins (the repo has no render
// harness); live chain discovery is verified separately per run.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const V3_CONTRACT = "omnibounty-v3.testnet";
const V3_ESCROW = "0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767";

describe("no V1 creation option exposed", () => {
  it("new-bounty page offers only the V3 sponsorship form", () => {
    const src = read("app/bounties/new/page.tsx");
    assert.ok(!src.includes("SponsorForm\""), "no V1 form import");
    assert.ok(!src.includes("V1 bounty"), "no V1 choice label");
    assert.ok(!src.includes('"v1"'), "no version toggle state");
    assert.ok(src.includes("<SponsorFormV3 />"), "V3 form is the only creation path");
  });

  it("V1 sponsorship implementation is gone and unreferenced", () => {
    assert.equal(existsSync(join(ROOT, "components", "SponsorForm.tsx")), false);
    assert.equal(existsSync(join(ROOT, "lib", "sponsorV1.mjs")), false);
    for (const f of ["app/bounties/new/page.tsx", "components/SponsorFormV3.tsx"]) {
      assert.ok(!read(f).includes("SponsorForm\""), `${f} never references V1 creation`);
    }
  });

  it("navigation and footer carry no legacy version labels", () => {
    assert.ok(read("app/layout.tsx").includes("OmniBounty V3"), "footer names V3");
    assert.ok(!read("app/layout.tsx").includes("OmniBounty V2"), "no stale generation label");
  });
});

describe("V3-only routing and configuration", () => {
  it("defaults target the deployed V3 contracts", () => {
    const src = read("lib/config.ts");
    assert.ok(
      src.includes(`env("NEXT_PUBLIC_CONTRACT_ID", "${V3_CONTRACT}")`),
      "default NEAR contract is V3"
    );
    assert.ok(
      src.includes(`env("NEXT_PUBLIC_ESCROW_ADDRESS", "${V3_ESCROW}")`),
      "default Base escrow is V2"
    );
  });

  it("documents V3 as the default with V2 as the legacy override", () => {
    const src = read(".env.example");
    assert.ok(src.includes(`NEXT_PUBLIC_CONTRACT_ID=${V3_CONTRACT}`), "example targets V3");
    assert.ok(src.includes(`NEXT_PUBLIC_ESCROW_ADDRESS=${V3_ESCROW}`), "example escrow is V2");
    assert.ok(src.includes("Legacy V2 deployment"), "V2 kept as a documented override");
  });

  it("creation copy describes the V3 flow including NEAR confirmation", () => {
    const src = read("app/bounties/new/page.tsx");
    assert.ok(src.includes("acceptance-criteria"), "lede names the criteria document");
    assert.ok(src.includes("confirming"), "lede mentions the NEAR confirmation step");
  });
});

describe("structured sponsorship wiring", () => {
  const src = read("components/SponsorFormV3.tsx");

  it("builds criteria from structured fields through the strict gate", () => {
    assert.ok(src.includes("buildCriteriaDocument"), "form composes criteria from fields");
    assert.ok(src.includes("validateSponsorV3Form"), "same strict validator still gates submit");
  });

  it("offers Simple fields with an Advanced JSON fallback", () => {
    assert.ok(src.includes("Criteria input mode"), "mode toggle exists");
    assert.ok(src.includes("Advanced JSON"), "full-power JSON path preserved");
    for (const label of ["Title", "Description", "GitHub repository", "Issue URL", "Reward slots", "Challenge window"]) {
      assert.ok(src.includes(label), `simple field: ${label}`);
    }
  });

  it("previews the real contributor-facing listing", () => {
    assert.ok(src.includes("{previewParams.title}"), "preview shows the criteria title");
    assert.ok(src.includes("previewParams.description"), "preview shows the description");
  });
});

describe("contributor bounty details wiring", () => {
  const details = read("components/CriteriaDetails.tsx");

  it("renders hash-verified task information with honest fallbacks", () => {
    assert.ok(details.includes("fetchCriteriaDocument"), "loads the served criteria artifact");
    assert.ok(details.includes("Loading the bounty description"), "loading state is explicit");
    assert.ok(details.includes("published the criteria document"), "missing artifact stays honest");
    assert.ok(details.includes("Retry"), "failed loads offer retry");
    for (const token of ["doc.title", "doc.description", "doc.repo", "doc.issue", "merge_policy"]) {
      assert.ok(details.includes(token), `renders verified ${token}`);
    }
    assert.ok(details.includes("Verified against the on-chain criteria hash"), "verification is stated");
  });

  it("mounts the details section on the V3 bounty page in isolation", () => {
    const page = read("app/bounties/[id]/page.tsx");
    assert.ok(page.includes("<h2>About this bounty</h2>"), "detail page has a task section");
    assert.ok(page.includes('label="bounty details"'), "section failure cannot take the page");
    assert.ok(page.includes("<CriteriaDetails key={bounty.id}"), "details remount per bounty");
  });
});

describe("V3 discovery wiring", () => {
  it("marketplace renders whatever bounties the configured contract lists", () => {
    const market = read("components/Marketplace.tsx");
    assert.ok(market.includes("{visible.map((b) =>"), "every listed bounty gets a card");
    assert.ok(read("app/page.tsx").includes("listBounties(0, 200)"), "homepage lists from chain");
  });

  it("detail pages resolve bounties by id from chain", () => {
    const page = read("app/bounties/[id]/page.tsx");
    assert.ok(page.includes("getBountyV3(bountyId)"), "V3 detail reads by id");
    assert.ok(page.includes("does not exist on NEAR"), "unknown ids stay honest");
  });
});

describe("V3 safeguards and prior fixes preserved", () => {
  it("keeps V3 preflight, reconcile, guards, and recovery wiring", () => {
    const form = read("components/SponsorFormV3.tsx");
    assert.ok(form.includes("reconcileSponsorV3"), "reconcile intact");
    assert.ok(form.includes("guardedIo"), "per-write wallet guards intact");
    assert.ok(form.includes("tryAcquire()"), "double-submit guard intact");
    assert.ok(form.includes("if (!mountedRef.current) return;"), "unmount guards intact");
    assert.ok(form.includes("mark_funded"), "NEAR confirmation step intact");
  });

  it("keeps V3 claim, settlement, tracker, and P0-P1 protections", () => {
    assert.ok(read("components/ClaimFormV3.tsx").includes("getClaimByPr(bountyId"), "lost-receipt check intact");
    assert.ok(read("components/SettlementPanel.tsx").includes("createSettlePoller"), "P1-10 intact");
    assert.ok(
      read("components/ReturningClaimTracker.tsx").includes("summarizeOwnClaimScan"),
      "P1-13 tracker intact"
    );
    assert.ok(read("components/wallets.tsx").includes("walletInitReducer"), "P1-9 intact");
    assert.ok(read("lib/near.ts").includes("interpretNearTxOutcome"), "P1-8 intact");
    assert.ok(read("components/Marketplace.tsx").includes("pool.run"), "P1-11 intact");
    assert.ok(read("components/Marketplace.tsx").includes("ErrorBoundary"), "P1-12 intact");
  });
});
