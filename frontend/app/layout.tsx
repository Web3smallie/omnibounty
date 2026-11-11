import type { Metadata } from "next";
import "./globals.css";
import WalletControls from "../components/WalletControls";
import { WalletsProvider } from "../components/wallets";

export const metadata: Metadata = {
  title: "OmniBounty — USDC bounties for merged pull requests",
  description:
    "Sponsors fund GitHub bounties in USDC on Base Sepolia. Contributors prove a merged pull request with Reclaim zkTLS and get paid.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletsProvider>
          <header className="topbar">
            <a className="brand" href="/">
              <span className="brand-mark" aria-hidden="true">
                ◈
              </span>
              OmniBounty
            </a>
            <nav className="links">
              <a href="/#browse">Browse</a>
              <a href="/bounties/new">New bounty</a>
            </nav>
            <WalletControls />
          </header>
          <main>{children}</main>
          <footer className="footer">
            <span>OmniBounty V2 · Base Sepolia × NEAR testnet</span>
            <span className="muted small">All bounty data, vouchers, and payouts are read live from chain.</span>
          </footer>
        </WalletsProvider>
      </body>
    </html>
  );
}
