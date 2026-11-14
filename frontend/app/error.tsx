"use client";

import { useEffect } from "react";
import { describeComponentError, reportComponentError } from "../lib/errorRecovery.mjs";

/// Route-segment backstop: catches render failures anywhere in the route
/// (including server-component rendering) that no section boundary
/// contained, and offers Next's segment retry.
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportComponentError({ label: "page", error });
  }, [error]);

  const { message } = describeComponentError(error) as { message: string };
  return (
    <div className="notice error" role="alert">
      <strong>This page failed to load.</strong> <span className="muted small">{message}</span>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => reset()}>Try again</button>
      </div>
    </div>
  );
}
