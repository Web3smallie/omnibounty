const nodeCrypto = require('crypto');
try {
  Object.defineProperty(globalThis.crypto, 'randomBytes', {
    value: nodeCrypto.randomBytes,
    configurable: true,
    writable: true
  });
} catch (e) {
  console.log("Could not define on globalThis.crypto:", e.message);
}

const { createClaimOnAttestor } = require('@reclaimprotocol/attestor-core');
const { ethers } = require('ethers');

async function testAttestorDirect() {
  console.log("=== Testing createClaimOnAttestor with crypto polyfill ===");
  const wallet = ethers.Wallet.createRandom();
  console.log("Generated wallet address (owner):", wallet.address);

  const attestorUrl = "wss://attestor.reclaimprotocol.org:444/ws";
  console.log("Connecting to attestor:", attestorUrl);

  const t0 = Date.now();
  try {
    const claim = await createClaimOnAttestor({
      name: "http",
      params: {
        method: "GET",
        url: "https://api.github.com/repos/facebook/react/pulls/1",
        responseMatches: [
          {
            type: "regex",
            value: '"state":"(?<state>.*?)"'
          }
        ],
        headers: {
          "User-Agent": "Mozilla/5.0"
        },
        responseRedactions: [],
        body: ""
      },
      secretParams: {
        cookieStr: "",
        headers: {}
      },
      zkEngine: "stwo",
      ownerPrivateKey: wallet.privateKey,
      client: {
        url: attestorUrl
      }
    });

    console.log(`Attestor returned in ${(Date.now() - t0) / 1000}s!`);
    console.log("Claim result:", claim);
  } catch (err) {
    console.error(`Attestor call failed in ${(Date.now() - t0) / 1000}s:`, err.message);
    if (err.stack) console.error(err.stack);
  }
}

testAttestorDirect();
