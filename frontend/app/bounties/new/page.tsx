import SponsorForm from "../../../components/SponsorForm";

export default function NewBountyPage() {
  return (
    <>
      <h1>New bounty</h1>
      <p className="lede">
        Register the bounty template on NEAR, then create, approve, and fund it with USDC on
        Base Sepolia. You need a connected NEAR wallet and an EVM wallet on Base Sepolia.
      </p>
      <SponsorForm />
    </>
  );
}
