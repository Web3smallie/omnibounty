//! Cross-contract tests: OmniBounty <-> MPC signer through real promises.
//!
//! Network selection via `OMNIBOUNTY_NETWORK` (`sandbox` default, `testnet`):
//!
//! - **sandbox**: deploys the mock MPC (`tests/mock-mpc`, exact v3.18.0
//!   wire shapes, fixed test key) plus OmniBounty. Exercises the full
//!   promise/callback machinery, including MPC outage / garbage-response /
//!   wrong-signer failure injection. Requires a Linux/macOS host: the
//!   near-sandbox binary does not exist for Windows (see
//!   `near-sandbox-utils::platform`), so these tests fail loudly on
//!   Windows with instructions instead of silently skipping.
//! - **testnet**: deploys OmniBounty against the REAL
//!   `v1.signer-prod.testnet`. This is the live MPC handshake: the test
//!   uses the same `dev_*` helpers as sandbox (funded `*.testnet`
//!   subaccounts via the helper), pins the signer from the live
//!   `derived_public_key` view, runs a real claim, and exports
//!   `testdata/live_voucher.json` for the Foundry live-escrow test,
//!   closing the NEAR -> Base loop.
//!
//! Prerequisites (both modes): prebuilt wasms. From `contracts/near`:
//!
//! ```sh
//! cargo build --target wasm32-unknown-unknown --release
//! cargo build --target wasm32-unknown-unknown --release \
//!     --manifest-path tests/mock-mpc/Cargo.toml
//! cargo test --test cross_contract
//! ```

use near_workspaces::network::{Sandbox, Testnet, TopLevelAccountCreator};
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, DevNetwork, Network, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn omni_wasm() -> Vec<u8> {
    let p = workspace_root().join("target/wasm32-unknown-unknown/release/omnibounty.wasm");
    std::fs::read(&p).unwrap_or_else(|_| {
        panic!(
            "missing OmniBounty wasm at {}. Build it first:\n  \
             cargo build --target wasm32-unknown-unknown --release",
            p.display()
        )
    })
}

fn mock_wasm() -> Vec<u8> {
    let p = workspace_root()
        .join("tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm");
    std::fs::read(&p).unwrap_or_else(|_| {
        panic!(
            "missing mock-MPC wasm at {}. Build it first:\n  \
             cargo build --target wasm32-unknown-unknown --release \
             --manifest-path tests/mock-mpc/Cargo.toml",
            p.display()
        )
    })
}

fn fixture() -> Value {
    let p = workspace_root().join("../../testdata/e2e_claim.json");
    let raw = std::fs::read_to_string(&p).expect("read e2e fixture");
    serde_json::from_str(&raw).expect("parse e2e fixture")
}

fn network_name() -> String {
    std::env::var("OMNIBOUNTY_NETWORK").unwrap_or_else(|_| "sandbox".to_string())
}

/// Shared setup on any dev network. Returns (owner, contract).
async fn deploy_omni<T>(
    worker: &Worker<T>,
    mpc_contract: &str,
) -> anyhow::Result<(Account, Contract)>
where
    T: DevNetwork + 'static,
{
    let owner = worker.dev_create_account().await?;
    let contract = worker.dev_deploy(&omni_wasm()).await?;
    init_contract(&owner, &contract, mpc_contract).await?;
    Ok((owner, contract))
}

async fn init_contract(
    owner: &Account,
    contract: &Contract,
    mpc_contract: &str,
) -> anyhow::Result<()> {
    let fx = fixture();
    let out = owner
        .call(contract.id(), "new")
        .args_json(json!({
            "owner": owner.id(),
            "mpc_contract": mpc_contract,
            "escrow": fx["config"]["escrow"],
            "chain_id": fx["config"]["chainId"],
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "new failed: {out:?}");
    Ok(())
}

/// Epoch + signer + clock-independent freshness + bounty. Returns the
/// bounty id used.
async fn configure(
    owner: &Account,
    contract: &Contract,
    mpc_signer: &str,
    bounty_id: u64,
) -> anyhow::Result<()> {
    let fx = fixture();
    // Pin the epoch witness from the fixture.
    let out = owner
        .call(contract.id(), "upsert_epoch")
        .args_json(json!({"epoch_id": 1, "witnesses": [fx["witness"]]}))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "upsert_epoch failed: {out:?}");
    // Pin the MPC signer.
    let out = owner
        .call(contract.id(), "set_mpc_signer")
        .args_json(json!({"signer": mpc_signer}))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "set_mpc_signer failed: {out:?}");
    // Clock-independent freshness: the fixture proof has a fixed
    // timestamp, so allow a wide window (the freshness LOGIC is covered
    // by unit tests with controlled block timestamps).
    let out = owner
        .call(contract.id(), "set_freshness")
        .args_json(json!({
            "max_proof_age_sec": 10u64 * 365 * 24 * 3600,
            "future_skew_sec": 24 * 3600,
            "voucher_ttl_sec": 24 * 3600,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "set_freshness failed: {out:?}");
    // Bounty matching the fixture proof's context-extracted parameters,
    // exactly as the on-chain template check reads them.
    let ctx: Value =
        serde_json::from_str(fx["proof"]["claimInfo"]["context"].as_str().unwrap())?;
    let repo = ctx["extractedParameters"]["repo"].as_str().unwrap();
    let pr_number: u64 = ctx["extractedParameters"]["number"]
        .as_str()
        .unwrap()
        .parse()?;
    let out = owner
        .call(contract.id(), "create_bounty")
        .args_json(json!({
            "bounty_id": bounty_id,
            "repo": repo,
            "pr_number": pr_number,
            "token": fx["config"]["token"],
            "amount": fx["config"]["amount"],
            "expiry": 0,
        }))
        .deposit(NearToken::from_yoctonear(0))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "create_bounty failed: {out:?}");
    Ok(())
}

async fn bounty_status(contract: &Contract, bounty_id: u64) -> anyhow::Result<String> {
    let v: Value = contract
        .view("get_bounty")
        .args_json(json!({"bounty_id": bounty_id}))
        .await?
        .json()?;
    Ok(v["status"].as_str().unwrap().to_string())
}

/// Full claim lifecycle on an already-deployed contract. Account/Contract
/// are network-erased, so this runs identically on sandbox and testnet.
async fn run_lifecycle(
    owner: &Account,
    contract: &Contract,
    mpc_signer: &str,
) -> anyhow::Result<Value> {
    let fx = fixture();
    let bounty_id = fx["config"]["bountyId"].as_u64().unwrap();
    configure(owner, contract, mpc_signer, bounty_id).await?;

    let recipient = fx["proof"]["signedClaim"]["claim"]["owner"]
        .as_str()
        .unwrap();
    // dry_run first: the digest it reports must equal the finally signed
    // digest (same nonce, no interleaving claims on a fresh contract).
    let dry: String = contract
        .view("dry_run")
        .args_json(json!({
            "bounty_id": bounty_id,
            "proof": fx["proof"],
            "recipient": recipient,
        }))
        .await?
        .json()?;
    assert!(dry.starts_with("OK digest="), "dry_run failed: {dry}");

    let claim_out = owner
        .call(contract.id(), "claim")
        .args_json(json!({
            "bounty_id": bounty_id,
            "proof": fx["proof"],
            "recipient": recipient,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        claim_out.is_success(),
        "claim failed: {:?}\nlogs: {:?}",
        claim_out,
        claim_out.logs()
    );
    let logs = claim_out.logs().join("\n");
    assert!(logs.contains("claim_submitted"), "logs: {logs}");
    assert!(logs.contains("voucher_signed"), "logs: {logs}");

    assert_eq!(bounty_status(contract, bounty_id).await?, "claimed");
    let voucher: Value = contract
        .view("get_voucher")
        .args_json(json!({"bounty_id": bounty_id}))
        .await?
        .json()?;
    // NOTE: dry_run and claim run in different blocks, so the TTL-based
    // expiry (and hence the digest) legitimately differs. Every other field
    // must match; expiry must be close to the dry_run value.
    let dry_parts: std::collections::HashMap<&str, &str> = dry
        .split_whitespace()
        .skip(1)
        .filter_map(|p| p.split_once('='))
        .collect();
    let vv = &voucher["voucher"];
    assert_eq!(vv["bounty_id"], bounty_id);
    assert_eq!(
        vv["recipient"].as_str().unwrap().to_lowercase(),
        recipient.to_lowercase()
    );
    assert_eq!(
        vv["token"].as_str().unwrap().to_lowercase(),
        fx["config"]["token"].as_str().unwrap().to_lowercase()
    );
    assert_eq!(vv["amount"].as_str().unwrap(), fx["config"]["amount"].as_str().unwrap());
    assert_eq!(vv["nonce"].as_u64().unwrap().to_string(), dry_parts["nonce"]);
    assert_eq!(vv["chain_id"].as_u64().unwrap(), fx["config"]["chainId"].as_u64().unwrap());
    let expiry_drift =
        (vv["expiry"].as_u64().unwrap() as i64 - dry_parts["expiry"].parse::<i64>().unwrap()).abs();
    assert!(expiry_drift <= 900, "expiry drift too large: {expiry_drift}");
    assert!(voucher["v"] == 27 || voucher["v"] == 28);
    assert_eq!(vv["nonce"], 0);
    // Identifier nullified.
    let used: bool = contract
        .view("is_identifier_used")
        .args_json(json!({
            "identifier_hex": fx["proof"]["signedClaim"]["claim"]["identifier"]
        }))
        .await?
        .json()?;
    assert!(used, "identifier must be nullified after success");
    // Same proof, second bounty (same repo/pr): identifier replay.
    configure(owner, contract, mpc_signer, bounty_id + 1000).await?;
    let replay_out = owner
        .call(contract.id(), "claim")
        .args_json(json!({
            "bounty_id": bounty_id + 1000,
            "proof": fx["proof"],
            "recipient": recipient,
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(replay_out.is_failure(), "replay must fail: {replay_out:?}");
    assert!(
        format!("{replay_out:?}").contains("IDENTIFIER_REPLAY"),
        "expected IDENTIFIER_REPLAY: {replay_out:?}"
    );
    Ok(voucher)
}

#[tokio::test]
async fn claim_lifecycle_selected_network() -> anyhow::Result<()> {
    match network_name().as_str() {
        "sandbox" => {
            let worker = near_workspaces::sandbox().await.map_err(|e| {
                anyhow::anyhow!(
                    "sandbox unavailable ({e}). The near-sandbox binary has no Windows \
                     build; run the live suite with OMNIBOUNTY_NETWORK=testnet, or run \
                     this on Linux/macOS."
                )
            })?;
            // Mock MPC first: its address becomes the pinned signer.
            let mock = worker.dev_deploy(&mock_wasm()).await?;
            let mock_owner = worker.dev_create_account().await?;
            let out = mock_owner
                .call(mock.id(), "new")
                .max_gas()
                .transact()
                .await?;
            assert!(out.is_success(), "mock new failed: {out:?}");
            let signer: String =
                mock.view("signer_address").await?.json()?;
            let (owner, contract) =
                deploy_omni(&worker, mock.id().as_str()).await?;
            run_lifecycle(&owner, &contract, &signer).await?;
            Ok(())
        }
        "testnet" => {
            let worker = near_workspaces::testnet().await?;
            let (owner, contract) =
                deploy_omni(&worker, "v1.signer-prod.testnet").await?;
            // Live signer address via the independently verified
            // derivation tool, run fresh for THIS contract id (the
            // derivation binds the predecessor id, so no two runs share
            // an address). The tool asserts root --KDF--> derived MATCH
            // on every run; a mismatch fails here, not silently.
            let tool = workspace_root().join("../../tools/mpc_derive.mjs");
            assert!(
                tool.exists(),
                "missing derivation tool at {}",
                tool.display()
            );
            let derive_out = std::process::Command::new("node")
                .arg(&tool)
                .arg(contract.id().as_str())
                .arg("omnibounty-voucher-v1")
                .output()?;
            assert!(
                derive_out.status.success(),
                "mpc_derive.mjs failed: {}",
                String::from_utf8_lossy(&derive_out.stderr)
            );
            let derived_json: Value =
                serde_json::from_slice(&derive_out.stdout)?;
            assert_eq!(
                derived_json["kdfCheck"], "MATCH",
                "KDF cross-check failed: {derived_json}"
            );
            let mpc_signer =
                derived_json["voucherAddress"].as_str().unwrap().to_string();
            let derived_key =
                derived_json["derivedKey"].as_str().unwrap().to_string();
            // Cross-check the tool's key against a direct RPC view.
            let direct: String = owner
                .view(
                    &"v1.signer-prod.testnet".parse()?,
                    "derived_public_key",
                )
                .args_json(json!({
                    "path": "omnibounty-voucher-v1",
                    "predecessor": contract.id(),
                    "domain_id": null,
                }))
                .await?
                .json()?;
            assert_eq!(direct, derived_key, "tool/RPC key mismatch");
            let voucher =
                run_lifecycle(&owner, &contract, &mpc_signer).await?;
            // Export the live vector for the Foundry escrow test.
            let live = json!({
                "network": "testnet",
                "contract": contract.id().as_str(),
                "mpcVersion": "3.18.0",
                "mpcSigner": mpc_signer,
                "derivedKey": derived_key,
                "voucher": voucher["voucher"],
                "v": voucher["v"],
                "r": voucher["r"],
                "s": voucher["s"],
            });
            let live_path =
                workspace_root().join("../../testdata/live_voucher.json");
            std::fs::write(&live_path, serde_json::to_string_pretty(&live)?)?;
            println!("live vector exported to {}", live_path.display());
            Ok(())
        }
        other => anyhow::bail!(
            "unknown OMNIBOUNTY_NETWORK={other}; want sandbox|testnet"
        ),
    }
}

/// Sandbox failure-injection matrix. Always uses sandbox (it needs the
/// mock), regardless of OMNIBOUNTY_NETWORK.
#[tokio::test]
async fn mpc_failures_release_for_retry() -> anyhow::Result<()> {
    let worker: Worker<Sandbox> = near_workspaces::sandbox().await.map_err(|e| {
        anyhow::anyhow!(
            "sandbox unavailable ({e}). The near-sandbox binary has no Windows \
             build; run this on Linux/macOS."
        )
    })?;
    let fx = fixture();
    let bounty_id = fx["config"]["bountyId"].as_u64().unwrap();
    let mock_owner = worker.dev_create_account().await?;
    let mock = worker.dev_deploy(&mock_wasm()).await?;
    let out = mock_owner.call(mock.id(), "new").max_gas().transact().await?;
    assert!(out.is_success(), "mock new failed: {out:?}");
    let signer: String = mock.view("signer_address").await?.json()?;

    let (owner, contract) = deploy_omni(&worker, mock.id().as_str()).await?;
    configure(&owner, &contract, &signer, bounty_id).await?;
    let recipient = fx["proof"]["signedClaim"]["claim"]["owner"]
        .as_str()
        .unwrap();
    let claim_args = || {
        json!({
            "bounty_id": bounty_id,
            "proof": fx["proof"],
            "recipient": recipient,
        })
    };

    for (mode, expect) in [(1u8, "MPC_FAILED"), (2u8, "MPC_BAD_RESPONSE"), (3u8, "MPC_SIGNER_MISMATCH")] {
        let out = mock_owner
            .call(mock.id(), "set_mode")
            .args_json(json!({"mode": mode}))
            .max_gas()
            .transact()
            .await?;
        assert!(out.is_success(), "set_mode failed: {out:?}");
        let claim_out = owner
            .call(contract.id(), "claim")
            .args_json(claim_args())
            .max_gas()
            .transact()
            .await?;
        // The callback returns `Rejected(code)` with a SUCCESSFUL receipt:
        // a panic would roll the release back and wedge the bounty in
        // `Pending` (bounty #3 incident). The stable code is asserted on
        // the return value, plus the `voucher_rejected` log.
        let logs = claim_out.logs().join("\n");
        assert!(
            claim_out.is_success(),
            "mode {mode} callback must commit, not panic: {claim_out:?}"
        );
        let ret: Value = claim_out.json()?;
        let rejected = ret.get("Rejected").and_then(Value::as_str).unwrap_or("");
        assert!(
            rejected.contains(expect),
            "mode {mode}: expected {expect} in {ret}"
        );
        assert!(
            logs.contains("voucher_rejected"),
            "mode {mode}: missing voucher_rejected log:\n{logs}"
        );
        assert_eq!(
            bounty_status(&contract, bounty_id).await?,
            "open",
            "mode {mode} must release the bounty"
        );
    }

    // Retry after the outage succeeds and nullifies.
    let out = mock_owner
        .call(mock.id(), "set_mode")
        .args_json(json!({"mode": 0}))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "set_mode failed: {out:?}");
    let claim_out = owner
        .call(contract.id(), "claim")
        .args_json(claim_args())
        .max_gas()
        .transact()
        .await?;
    assert!(
        claim_out.is_success(),
        "retry failed: {:?}\nlogs: {:?}",
        claim_out,
        claim_out.logs()
    );
    assert_eq!(bounty_status(&contract, bounty_id).await?, "claimed");
    Ok(())
}

#[allow(dead_code)]
fn _assert_network_types() {
    fn is_dev<T: DevNetwork>() {}
    is_dev::<Sandbox>();
    is_dev::<Testnet>();
    fn is_tla<T: TopLevelAccountCreator>() {}
    is_tla::<Sandbox>();
    fn is_net<T: Network>() {}
    is_net::<Sandbox>();
    is_net::<Testnet>();
}
