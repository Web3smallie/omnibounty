//! RUSTC_WRAPPER that links NEAR host stubs into host-target links only.
//!
//! Windows-only workaround for cargo-near ABI extraction (see
//! `tools/gen_hoststubs.py`): the ABI dylib needs the host symbols, the
//! wasm build must not see them. Enabled by setting RUSTC_WRAPPER to this
//! binary plus NEAR_HOST_STUBS_DIR to the stub .lib directory.

use std::process::{exit, Command};

fn main() {
    let mut argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 {
        eprintln!("rustc-wrapper: expected rustc path as argv[1]");
        exit(2);
    }
    let rustc = argv.remove(1);
    let is_wasm = argv.windows(2).any(|w| {
        w[0] == "--target" && w[1].starts_with("wasm32")
    }) || argv.iter().any(|a| a == "--target=wasm32-unknown-unknown");
    let mut cmd = Command::new(rustc);
    cmd.args(&argv[1..]);
    if !is_wasm {
        if let Ok(dir) = std::env::var("NEAR_HOST_STUBS_DIR") {
            cmd.arg("-L").arg(format!("native={dir}"));
            cmd.arg("-l").arg("static=near_host_stubs");
        }
    }
    let status = cmd.status().expect("spawn rustc");
    exit(status.code().unwrap_or(1));
}
