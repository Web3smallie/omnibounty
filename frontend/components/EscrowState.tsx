"use client";

import { useEffect, useState } from "react";
import { escrowBountyState } from "../lib/base";
import { FundingPill } from "./ui";

/// Live escrow funding badge, read client-side from Base Sepolia.
export default function EscrowState({ bountyId }: { bountyId: number }) {
  const [state, setState] = useState<{ funded: boolean; claimed: boolean } | "error" | null>(null);

  useEffect(() => {
    let live = true;
    escrowBountyState(bountyId)
      .then((s) => {
        if (live) setState(s);
      })
      .catch(() => {
        if (live) setState("error");
      });
    return () => {
      live = false;
    };
  }, [bountyId]);

  if (state === "error") return <span className="pill pill-unknown">Escrow unreachable</span>;
  return <FundingPill funded={state?.funded ?? null} claimed={state?.claimed ?? null} />;
}
