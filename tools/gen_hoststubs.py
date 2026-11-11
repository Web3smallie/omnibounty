#!/usr/bin/env python3
"""Generate a Windows link stub for cargo-near ABI extraction (local only).

cargo-near's ABI step builds the contract as a host dylib and loads it to
extract schemas. On Linux/macOS undefined NEAR host imports are allowed in
shared libraries; on Windows the DLL link fails (LNK2019) because nothing
provides `read_register`, `input`, etc.

This script generates a tiny `staticlib` crate that defines every host
symbol as an uncalled stub. Link it ONLY into the host dylib step via the
target-specific flags (see usage) — never into the wasm build. The stubs
are never executed: schema extraction calls only the generated ABI entry
point, which builds schema objects without touching host functions.

The symbol list matches near-sys 0.2.1 (near-sdk 5.1.0's dependency);
re-extract from the vendored near-sys source if the SDK version changes.

Usage:
  python tools/gen_hoststubs.py <out-dir>
  # then, host-target flags only:
  #   CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-L native=<out-dir>/target/release -l static:near_host_stubs"
"""
import os
import sys

# `extern "C"` host imports declared by near-sys 0.2.1 (src/lib.rs).
SYMBOLS = """\
abort account_balance account_locked_balance
alt_bn128_g1_multiexp alt_bn128_g1_sum alt_bn128_pairing_check
attached_deposit block_index block_timestamp current_account_id
ecrecover ed25519_verify epoch_height input
keccak256 keccak512 log_utf16 log_utf8 panic panic_utf8
predecessor_account_id prepaid_gas
promise_and promise_batch_action_add_key_with_full_access
promise_batch_action_add_key_with_function_call
promise_batch_action_create_account promise_batch_action_delete_account
promise_batch_action_delete_key promise_batch_action_deploy_contract
promise_batch_action_function_call promise_batch_action_function_call_weight
promise_batch_action_stake promise_batch_action_transfer
promise_batch_create promise_batch_then promise_create
promise_result promise_results_count promise_return promise_then
random_seed read_register register_len ripemd160 sha256
signer_account_id signer_account_pk storage_has_key
storage_iter_next storage_iter_prefix storage_iter_range
storage_read storage_remove storage_usage storage_write
used_gas validator_stake validator_total_stake value_return
write_register""".split()

LIB_RS = '''//! Uncalled NEAR host stubs: link-only shims so the cargo-near ABI
//! dylib links on Windows. Every body is unreachable by construction
//! (schema extraction never invokes host functions).

%s
'''


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = sys.argv[1]
    srcdir = os.path.join(out, "src")
    os.makedirs(srcdir, exist_ok=True)
    fns = "\n".join(
        f'#[no_mangle]\npub extern "C" fn {s}() '
        "{ unimplemented!(\"NEAR host stub called\") }"
        for s in SYMBOLS
    )
    with open(os.path.join(out, "Cargo.toml"), "w", encoding="utf-8",
              newline="\n") as f:
        f.write('[package]\nname = "near-host-stubs"\nversion = "0.0.0"\n'
                'edition = "2021"\n\n[lib]\ncrate-type = ["staticlib"]\n')
    with open(os.path.join(srcdir, "lib.rs"), "w", encoding="utf-8",
              newline="\n") as f:
        f.write(LIB_RS % fns)
    print(f"wrote stub crate ({len(SYMBOLS)} symbols) to {out}")


if __name__ == "__main__":
    main()
