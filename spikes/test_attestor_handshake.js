const { ReclaimClient } = require('@reclaimprotocol/zk-fetch');
const { ethers } = require('ethers');

// Intercept fetch for get-zk-enabled-app and business-logs
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(url, options) {
  const urlStr = url.toString();
  if (urlStr.includes('/api/applications/sdk/get-zk-enabled-app/')) {
    console.log("[Mock Fetch] Intercepted get-zk-enabled-app query for:", urlStr);
    return new Response(JSON.stringify({
      application: {
        id: "mock-app",
        name: "OmniBounty Spike Test"
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (urlStr.includes('/api/business-logs/zkfetch')) {
    console.log("[Mock Fetch] Intercepted sendLogs query");
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return originalFetch(url, options);
};

async function main() {
  const wallet = ethers.Wallet.createRandom();
  console.log("Using generated wallet:");
  console.log("App ID (Address):", wallet.address);
  console.log("App Secret (Private Key):", wallet.privateKey);

  const client = new ReclaimClient(wallet.address, wallet.privateKey, true, 1);

  console.log("\nStarting zkFetch on https://api.github.com/repos/facebook/react/pulls/1 ...");
  const startTime = Date.now();
  try {
    const proof = await client.zkFetch(
      "https://api.github.com/repos/facebook/react/pulls/1",
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
      },
      {
        responseMatches: [
          {
            type: "regex",
            value: '"state":"(?<state>.*?)"'
          }
        ]
      }
    );
    console.log(`\n>>> zkFetch SUCCEEDED in ${(Date.now() - startTime) / 1000}s! <<<`);
    console.log("Proof keys:", Object.keys(proof));
    console.log("Proof claimData:", JSON.stringify(proof.claimData, null, 2));
    console.log("Proof signatures count:", proof.signatures?.length);
    console.log("Proof witnesses:", JSON.stringify(proof.witnesses, null, 2));
  } catch (err) {
    console.error(`\n>>> zkFetch FAILED in ${(Date.now() - startTime) / 1000}s:`, err.message);
    if (err.stack) console.error(err.stack);
  }
}

main();
