import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// P2-5: accessibility regression pins. The repo has no DOM harness, so
// these assert the ARIA contracts statically in component source (the
// same convention as v3only/submitGuards): urgent dynamic errors use
// role="alert", advisory updates use role="status", validation errors
// are wired to their inputs, and every control has an accessible name.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// Client components whose error notices must all carry alert semantics.
// Server pages (app/page.tsx, app/bounties/[id]/page.tsx) are deliberately
// excluded: their notices render with the page and are encountered in
// reading order, where role="alert" would be disruptive, not helpful.
const ALERT_CLIENT_COMPONENTS = [
  "frontend/components/ClaimForm.tsx",
  "frontend/components/ClaimFormV3.tsx",
  "frontend/components/SponsorFormV3.tsx",
  "frontend/components/CriteriaPanel.tsx",
  "frontend/components/CriteriaDetails.tsx",
  "frontend/components/SettlementPanel.tsx",
  "frontend/components/WalletControls.tsx",
  "frontend/components/ErrorBoundary.tsx",
  "frontend/app/error.tsx",
  "frontend/app/global-error.tsx",
];

describe("dynamic error announcements (P2-5)", () => {
  it("gives every client error notice role=alert (or an equivalent dynamic role)", () => {
    for (const f of ALERT_CLIENT_COMPONENTS) {
      const lines = read(f).split("\n");
      lines.forEach((line, i) => {
        if (line.includes("aria-describedby") || line.includes("aria-invalid")) return;
        // wallet-chip-warn" in a template literal is the EVM chip's
        // conditional class (persistent UI, not an error notice).
        const failedChip = line.includes('wallet-chip-warn"') && !line.includes("`");
        if (!line.includes("notice error") && !line.includes("claim-errors") && !line.includes("sponsor-errors") && !line.includes("wallet-error") && !failedChip) return;
        if (line.includes("notice error") && !line.includes("className") && !line.includes("class=")) return;
        const window = lines.slice(i, i + 4).join("\n");
        assert.ok(
          window.includes('role="alert"') || window.includes("role={"),
          `${f}:${i + 1} renders an error without alert semantics: ${line.trim()}`
        );
      });
    }
  });

  it("announces wallet and transaction error states assertively", () => {
    for (const f of [
      "frontend/components/ClaimForm.tsx",
      "frontend/components/ClaimFormV3.tsx",
      "frontend/components/SponsorFormV3.tsx",
    ]) {
      const src = read(f);
      const i = src.indexOf("NEAR wallet setup failed");
      assert.ok(i >= 0, `${f} wallet-init error text intact`);
      assert.ok(
        src.slice(Math.max(0, i - 200), i).includes('role="alert"'),
        `${f} wallet-init error must be role=alert`
      );
    }
    const wallets = read("frontend/components/WalletControls.tsx");
    assert.ok(wallets.includes('className="wallet-error" role="alert"'), "EVM wallet error must be role=alert");
    assert.ok(wallets.includes('wallet-chip-warn" title={nearError'), "setup-failed chip keeps its detail");
    assert.ok(wallets.includes('role="alert"'), "setup-failed chip must be role=alert");
    assert.ok(
      read("frontend/components/ClaimForm.tsx").includes("Dry-run failed"),
      "dry-run failure text intact"
    );
  });

  it("keeps the expired-bounty and dry-run errors announced", () => {
    for (const f of ["frontend/components/ClaimForm.tsx", "frontend/components/ClaimFormV3.tsx"]) {
      const src = read(f);
      assert.ok(src.includes('<div className="notice error" role="alert">'), `${f} error notices need role=alert`);
      assert.ok(src.includes("past its deadline"), `${f} expiry copy intact`);
    }
  });
});

describe("non-urgent status announcements (P2-5)", () => {
  it("keeps polite live regions on loaders and progress", () => {
    assert.ok(read("frontend/components/ui.tsx").includes('role="status"'), "LoadingDots stays role=status");
    assert.ok(
      read("frontend/components/SettlementPanel.tsx").includes('aria-live="polite"'),
      "V3 step progress stays polite-live"
    );
  });

  it("announces success and advisory states with role=status, never role=alert", () => {
    const ok = [
      ["frontend/components/ClaimForm.tsx", "Claim submitted on NEAR"],
      ["frontend/components/ClaimFormV3.tsx", "Claim submitted on NEAR"],
      ["frontend/components/SponsorFormV3.tsx", "is open and funded"],
      ["frontend/components/SettlementPanel.tsx", "Paid out —"],
      ["frontend/components/SettlementPanel.tsx", "Settled on Base."],
      ["frontend/components/CriteriaPanel.tsx", "verified against the on-chain hash"],
      ["frontend/components/ClaimForm.tsx", "already has a claim"],
      ["frontend/components/ClaimFormV3.tsx", "already on NEAR"],
      ["frontend/components/SponsorFormV3.tsx", "warnings.map((w, i)"],
      ["frontend/components/ReturningClaimTracker.tsx", "Could not verify your claim"],
      ["frontend/components/ReturningClaimTracker.tsx", "No claim from the connected wallet yet"],
      ["frontend/components/ReturningClaimTracker.tsx", "tracking it below"],
      ["frontend/components/Marketplace.tsx", "No bounties match this search"],
      ["frontend/components/CriteriaDetails.tsx", "could not be resolved automatically"],
      ["frontend/components/SettlementPanel.tsx", "Settlement check paused"],
    ];
    for (const [f, snippet] of ok) {
      const lines = read(f).split("\n");
      const i = lines.findIndex((l) => l.includes(snippet));
      assert.ok(i >= 0, `${f} still renders: ${snippet}`);
      const window = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      assert.ok(window.includes('role="status"'), `${f} must announce politely: ${snippet}`);
      assert.ok(!window.includes('role="alert"'), `${f} must not alert for: ${snippet}`);
    }
  });

  it("uses status (not alert) for the missing-artifact advisory", () => {
    assert.ok(
      read("frontend/components/CriteriaPanel.tsx").includes('role={auto.reason === "missing" ? "status" : "alert"}'),
      "missing artifact stays advisory while real criteria errors alert"
    );
  });

  it("avoids nested live regions around loaders", () => {
    // Wrappers that already contain a role=status LoadingDots must not
    // add their own live region (double announcement).
    for (const f of [
      "frontend/components/ClaimForm.tsx",
      "frontend/components/ClaimFormV3.tsx",
      "frontend/components/SponsorFormV3.tsx",
      "frontend/components/SettlementPanel.tsx",
      "frontend/components/ReturningClaimTracker.tsx",
      "frontend/components/CriteriaDetails.tsx",
    ]) {
      const src = read(f);
      for (const m of src.matchAll(/<(div|p)([^>]*)>\s*\n?\s*<LoadingDots/g)) {
        assert.ok(
          !m[2].includes("role=") && !m[2].includes("aria-live"),
          `${f} must not nest a live region around LoadingDots: <${m[1]}${m[2]}>`
        );
      }
    }
  });
});

describe("form validation associations (P2-5)", () => {
  it("wires claim-form errors to both inputs", () => {
    for (const f of ["frontend/components/ClaimForm.tsx", "frontend/components/ClaimFormV3.tsx"]) {
      const src = read(f);
      assert.ok(src.includes('id="claim-errors" role="alert"'), `${f} error list needs id + alert`);
      const described = (src.match(/aria-describedby=\{errors\.length > 0 \? "claim-errors" : undefined\}/g) || []).length;
      assert.equal(described, 2, `${f} must describe both inputs with the error list`);
      const invalid = (src.match(/aria-invalid=\{errors\.length > 0\}/g) || []).length;
      assert.equal(invalid, 2, `${f} must mark both inputs invalid while errors show`);
    }
  });

  it("wires the criteria paste error to its textarea", () => {
    const src = read("frontend/components/CriteriaPanel.tsx");
    assert.ok(src.includes('id="criteria-paste-error" role="alert"'), "paste error needs id + alert");
    assert.ok(src.includes('aria-describedby={pastedResult !== null && !pastedResult.ok ? "criteria-paste-error" : undefined}'), "textarea must reference the paste error");
    assert.ok(src.includes("aria-invalid={pastedResult !== null && !pastedResult.ok}"), "textarea must flag invalid");
  });

  it("announces the sponsor error list (shared across many fields)", () => {
    // One shared list for ~10 inputs: per-input describedby would read the
    // whole list on every field, so the alert announcement plus field-named
    // messages ("slot #0: …", "criteria: …") is the association mechanism.
    assert.ok(
      read("frontend/components/SponsorFormV3.tsx").includes('id="sponsor-errors" role="alert"'),
      "sponsor error list needs id + alert"
    );
  });

  it("keeps every input, textarea, and select labelled", () => {
    for (const f of [
      "frontend/components/ClaimForm.tsx",
      "frontend/components/ClaimFormV3.tsx",
      "frontend/components/SponsorFormV3.tsx",
      "frontend/components/CriteriaPanel.tsx",
      "frontend/components/Marketplace.tsx",
    ]) {
      const src = read(f);
      const tokens = [...src.matchAll(/<label[\s>]|<\/label>|<(input|textarea|select)(?:=>|[^>])*?>/g)];
      let depth = 0;
      for (const t of tokens) {
        if (t[0] === "<label " || t[0] === "<label>") depth++;
        else if (t[0] === "</label>") depth--;
        else {
          // The full opening tag (=> tolerated inside handlers).
          const labelled = depth > 0 || t[0].includes("aria-label") || t[0].includes("aria-labelledby");
          assert.ok(labelled, `${f} has an unlabelled ${t[1]} control`);
        }
      }
    }
  });
});

describe("accessible names (P2-5)", () => {
  it("names the icon-only disconnect button", () => {
    const src = read("frontend/components/WalletControls.tsx");
    assert.ok(src.includes('aria-label="Disconnect NEAR wallet"'), "× button needs an accessible name");
    assert.ok(src.includes('<span aria-hidden="true">×</span>'), "× glyph must be hidden from AT");
  });

  it("gives every button a text or labelled name", () => {
    for (const f of [
      "frontend/components/ClaimForm.tsx",
      "frontend/components/ClaimFormV3.tsx",
      "frontend/components/SponsorFormV3.tsx",
      "frontend/components/CriteriaPanel.tsx",
      "frontend/components/CriteriaDetails.tsx",
      "frontend/components/SettlementPanel.tsx",
      "frontend/components/ReturningClaimTracker.tsx",
      "frontend/components/WalletControls.tsx",
      "frontend/components/Marketplace.tsx",
      "frontend/components/ErrorBoundary.tsx",
      "frontend/app/error.tsx",
      "frontend/app/global-error.tsx",
    ]) {
      const src = read(f);
      for (const m of src.matchAll(/<button([\s\S]*?)>/g)) {
        if (m[1].includes("aria-label")) continue;
        const after = src.slice(m.index + m[0].length);
        const text = after.slice(0, after.indexOf("<")).trim();
        assert.ok(text.length > 0, `${f} has a button without an accessible name`);
      }
    }
  });

  it("keeps search, filter, and mode groups labelled", () => {
    assert.ok(read("frontend/components/Marketplace.tsx").includes('aria-label="Search bounties"'), "search keeps its label");
    assert.ok(read("frontend/components/Marketplace.tsx").includes('aria-label="Filter by status"'), "filters keep their group label");
    assert.ok(read("frontend/components/SponsorFormV3.tsx").includes('aria-label="Criteria input mode"'), "criteria mode keeps its group label");
  });
});

describe("preserved protections (P2-5)", () => {
  it("keeps P1-12 error boundaries announcing with recovery intact", () => {
    for (const f of [
      "frontend/components/ErrorBoundary.tsx",
      "frontend/app/error.tsx",
      "frontend/app/global-error.tsx",
    ]) {
      assert.ok(read(f).includes('role="alert"'), `${f} keeps role=alert`);
    }
    const boundary = read("frontend/components/ErrorBoundary.tsx");
    assert.ok(boundary.includes("Retry {this.props.label}") || boundary.includes("Retry setup") || boundary.includes("this.retry"), "boundary retry intact");
    assert.ok(boundary.includes("Reload page"), "boundary reload intact");
  });

  it("keeps P1-10 settlement behavior and P2-4 suppression docs wired", () => {
    const src = read("frontend/components/SettlementPanel.tsx");
    assert.ok(src.includes("createSettlePoller"), "P1-10 poller intact");
    assert.ok(src.includes("settleStatus"), "P1-10 states intact");
    assert.ok(src.includes("Retry check") && src.includes("Retry scan"), "P1-10 retries intact");
    assert.ok(src.includes("Intentional: the poller"), "P2-4 justification intact");
  });
});
