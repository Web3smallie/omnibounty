const { ReclaimClient } = require('@reclaimprotocol/zk-fetch');

async function main() {
  console.log("Initializing ReclaimClient...");
  // Using a sample 32-byte hex key for testing
  const dummyAppId = "0x0000000000000000000000000000000000000000";
  const dummySecret = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const client = new ReclaimClient(dummyAppId, dummySecret, true, 1);

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
    console.log(`zkFetch succeeded in ${(Date.now() - startTime) / 1000}s!`);
    console.log("Proof keys:", Object.keys(proof));
    console.log("Proof claimData:", JSON.stringify(proof.claimData, null, 2));
    console.log("Proof signatures:", proof.signatures);
    console.log("Proof witnesses:", proof.witnesses);
  } catch (err) {
    console.error(`zkFetch failed in ${(Date.now() - startTime) / 1000}s:`, err);
  }
}

main();
