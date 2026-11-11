const zkFetchPkg = require('@reclaimprotocol/zk-fetch');
console.log("=== @reclaimprotocol/zk-fetch exports ===");
console.log(Object.keys(zkFetchPkg));

if (zkFetchPkg.ReclaimClient) {
  console.log("\nReclaimClient prototype methods:");
  console.log(Object.getOwnPropertyNames(zkFetchPkg.ReclaimClient.prototype));
  console.log("\nReclaimClient static properties:");
  console.log(Object.getOwnPropertyNames(zkFetchPkg.ReclaimClient));
  console.log("\nReclaimClient constructor string length:", zkFetchPkg.ReclaimClient.length);
  console.log("\nReclaimClient toString preview:");
  console.log(zkFetchPkg.ReclaimClient.toString().slice(0, 500));
}

try {
  const pkgJson = require('@reclaimprotocol/zk-fetch/package.json');
  console.log("\nPackage Version:", pkgJson.version);
  console.log("Dependencies:", pkgJson.dependencies);
} catch (e) {
  console.log("Error reading package.json:", e.message);
}
