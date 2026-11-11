const { ReclaimClient } = require('@reclaimprotocol/zk-fetch');
const { ethers } = require('ethers');

async function main() {
  const wallet = ethers.Wallet.createRandom();
  console.log("Generated test wallet:");
  console.log("Address (App ID):", wallet.address);
  console.log("Private Key (App Secret):", wallet.privateKey);

  const client = new ReclaimClient(wallet.address, wallet.privateKey, true, 1);
  console.log("Client created successfully!");

  console.log("Calling client.zkFetch on https://api.github.com/repos/facebook/react/pulls/1 ...");
  const startTime = Date.now();
  try {
    const proof = await client.zkFetch(
      "https://api.github.com/repos/facebook/react/pulls/1",
      {
        method: "GET",
        headers: {
          "User-Agent": "zk-fetch-test"
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
    console.log(`zkFetch SUCCEEDED in ${(Date.now() - startTime) / 1000}s!`);
    console.log("Proof object keys:", Object.keys(proof));
    console.log("Proof claimData:", JSON.stringify(proof.claimData, null, 2));
    console.log("Proof signatures:", proof.signatures);
    console.log("Proof witnesses:", proof.witnesses);
  } catch (err) {
    console.error(`zkFetch error in ${(Date.now() - startTime) / 1000}s:`, err.message);
    if (err.stack) console.error(err.stack);
  }
}

main();
