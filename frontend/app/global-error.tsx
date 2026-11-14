"use client";

import { useEffect } from "react";
import { describeComponentError, reportComponentError } from "../lib/errorRecovery.mjs";

/// Root backstop for failures in the layout itself. Next requires this
/// file to render its own document shell.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportComponentError({ label: "application", error });
  }, [error]);

  const { message } = describeComponentError(error) as { message: string };
  return (
    <html lang="en">
      <body>
        <div className="notice error" role="alert">
          <strong>OmniBounty failed to load.</strong> <span className="muted small">{message}</span>
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => reset()}>Try again</button>
          </div>
        </div>
      </body>
    </html>
  );
}
