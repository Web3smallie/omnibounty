const { verifyProof, createSignDataForClaim } = require('@reclaimprotocol/js-sdk');
const { ethers } = require('ethers');

// The exact proof generated in the previous step
const proof = {
  claimData: {
    provider: "http",
    parameters: JSON.stringify({
      body: "",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      method: "GET",
      responseMatches: [{ type: "regex", value: '"state":"(?<state>.*?)"' }],
      responseRedactions: [],
      url: "https://api.github.com/repos/react/react/pulls/1"
    }),
    owner: "0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9",
    timestampS: 1794129286,
    context: JSON.stringify({
      extractedParameters: { state: "closed" },
      providerHash: "0x1107f0dc35e4c1a899dc33c33f7cd5e90053561adf356dacbbec4be56ca7d0b6"
    }),
    identifier: "0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175",
    epoch: 1
  },
  identifier: "0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175",
  signatures: [
    "0xe1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca648a7a9289898fdb80ade7e6de733f62b5ffed9293aa6586b9b19b43502038591c"
  ],
  witnesses: [
    {
      id: "0x244897572368eadf65bfbc5aec98d8e5443a9072",
      url: "wss://attestor.reclaimprotocol.org:444/ws"
    }
  ]
};

async function testVerification() {
  console.log("=== Testing Proof Verification ===");

  // 1. Verify with Reclaim SDK's verifyProof
  try {
    const isValid = await verifyProof(proof);
    console.log("verifyProof(proof) result:", isValid);
  } catch (err) {
    console.error("verifyProof failed:", err.message);
  }

  // 2. Manual signature recovery: what is signed?
  console.log("\n=== Inspecting Cryptographic Signature ===");
  try {
    const signData = createSignDataForClaim({
      identifier: proof.claimData.identifier,
      owner: proof.claimData.owner,
      epoch: proof.claimData.epoch,
      timestampS: proof.claimData.timestampS
    });
    console.log("createSignDataForClaim string:", signData);

    // Hash signData
    const hash = ethers.utils.keccak256(new TextEncoder().encode(signData));
    console.log("Keccak256 hash of signData:", hash);

    const recoveredAddress = ethers.utils.recoverAddress(hash, proof.signatures[0]);
    console.log("Recovered witness address:", recoveredAddress);
    console.log("Expected witness address :", proof.witnesses[0].id);
    console.log("Signature match?", recoveredAddress.toLowerCase() === proof.witnesses[0].id.toLowerCase());
  } catch (err) {
    console.error("Manual recovery failed:", err);
  }
}

testVerification();
