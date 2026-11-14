import SponsorFormV3 from "../../../components/SponsorFormV3";
import ErrorBoundary from "../../../components/ErrorBoundary";

export default function NewBountyPage() {
  return (
    <>
      <h1>New bounty</h1>
      <p className="lede">
        Describe the work in an acceptance-criteria document, register the bounty template on
        NEAR, then create, approve, and fund it with USDC on Base Sepolia before confirming the
        funding on NEAR. You need a connected NEAR wallet and an EVM wallet on Base Sepolia.
      </p>
      <ErrorBoundary label="sponsor form">
        <SponsorFormV3 />
      </ErrorBoundary>
    </>
  );
}
