const sdk = require('@reclaimprotocol/js-sdk');

console.log("SDK Keys:", Object.keys(sdk));

if (sdk.ReclaimProofRequest) {
  console.log("ReclaimProofRequest prototype methods:", Object.getOwnPropertyNames(sdk.ReclaimProofRequest.prototype));
  console.log("ReclaimProofRequest static methods:", Object.getOwnPropertyNames(sdk.ReclaimProofRequest));
}

if (sdk.transformForOnchain) {
  console.log("transformForOnchain exists!");
}
