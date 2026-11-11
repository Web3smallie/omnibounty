import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Every NEAR wallet the connection modal offers. Each must be an official
// @near-wallet-selector module on the same v8 line as core (peer-checked at
// install time) whose setup factory imports without a browser. Actual
// signing always happens in the user's real wallet extension/app against
// the V2 contract id; nothing here simulates a wallet.
const WALLETS = [
  ["@near-wallet-selector/my-near-wallet", "setupMyNearWallet"],
  ["@near-wallet-selector/meteor-wallet", "setupMeteorWallet"],
  ["@near-wallet-selector/sender", "setupSender"],
  ["@near-wallet-selector/nightly", "setupNightly"],
  ["@near-wallet-selector/here-wallet", "setupHereWallet"],
];

describe("near wallet modules", () => {
  it("core and modal-ui are on the v8 line", () => {
    assert.match(require("@near-wallet-selector/core/package.json").version, /^8\./);
    assert.match(require("@near-wallet-selector/modal-ui/package.json").version, /^8\./);
  });

  for (const [pkg, factory] of WALLETS) {
    it(`${pkg} is installed on v8 and exports ${factory}`, async () => {
      assert.match(require(`${pkg}/package.json`).version, /^8\./);
      const mod = await import(pkg);
      assert.equal(typeof mod[factory], "function");
    });
  }
});
