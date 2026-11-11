const sdk = require('@reclaimprotocol/js-sdk');

const claimInfo = {
  provider: 'http',
  parameters: JSON.stringify({
    body: "",
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    method: "GET",
    responseMatches: [{ type: "regex", value: '"state":"(?<state>.*?)"' }],
    responseRedactions: [],
    url: "https://api.github.com/repos/react/react/pulls/1"
  }),
  context: JSON.stringify({
    extractedParameters: { state: "closed" },
    providerHash: "0x1107f0dc35e4c1a899dc33c33f7cd5e90053561adf356dacbbec4be56ca7d0b6"
  })
};

const id = sdk.getIdentifierFromClaimInfo(claimInfo);
const target = "0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175";
console.log("Computed identifier:", id);
console.log("Claim identifier   :", target);
console.log("Matches?", id.toLowerCase() === target.toLowerCase());
