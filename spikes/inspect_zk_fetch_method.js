const { ReclaimClient } = require('@reclaimprotocol/zk-fetch');

console.log("=== ReclaimClient.prototype.zkFetch string ===");
const zkFetchStr = ReclaimClient.prototype.zkFetch.toString();
console.log(zkFetchStr.slice(0, 1500));
