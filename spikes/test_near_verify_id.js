const sdk = require('@reclaimprotocol/js-sdk');
const fetch = globalThis.fetch || require('node-fetch');

const proof = {
  claimData: {
    provider: 'http',
    parameters: '{"body":"","headers":{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},"method":"GET","responseMatches":[{"type":"regex","value":"\\"state\\":\\"(?<state>.*?)\\""}],"responseRedactions":[],"url":"https://api.github.com/repos/react/react/pulls/1"}',
    owner: '0xcb234c6fc8abe3eb38e31eec6288b431e313d9b9',
    timestampS: 1794129286,
    context: '{"extractedParameters":{"state":"closed"},"providerHash":"0x1107f0dc35e4c1a899dc33c33f7cd5e90053561adf356dacbbec4be56ca7d0b6"}',
    identifier: '0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175',
    epoch: 1
  },
  signatures: [
    '0xe1fd48c836b97eea98ed877803164bbd04cfcde0722f0198c8252f7d9a1278ca648a7a9289898fdb80ade7e6de733f62b5ffed9293aa6586b9b19b43502038591c'
  ],
  witnesses: [
    {
      id: '0x244897572368eadf65bfbc5aec98d8e5443a9072',
      url: 'wss://attestor.reclaimprotocol.org:444/ws'
    }
  ]
};

const transformed = sdk.transformForOnchain(proof);

async function testWithIdentifier(idVal) {
  transformed.signedClaim.claim.identifier = idVal;
  const argsBase64 = Buffer.from(JSON.stringify({ proof: transformed })).toString('base64');
  console.log(`\nTesting with identifier: ${idVal.slice(0, 10)}...`);
  const res = await fetch('https://rpc.testnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'test',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: 'reclaim-protocol.testnet',
        method_name: 'verify_proof',
        args_base64: argsBase64
      }
    })
  });
  const data = await res.json();
  if (data.result && data.result.error) {
    console.log("Error:", data.result.error);
  } else {
    console.log("Success:", data);
  }
}

async function run() {
  await testWithIdentifier("0x94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175");
  await testWithIdentifier("94bb12417065a93c36cdf75539d16c0a25f707b882f4ea2b0b69272254357175");
}

run();
