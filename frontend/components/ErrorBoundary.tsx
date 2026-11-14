"use client";

import { Component } from "react";
import type { ReactNode } from "react";
import {
  boundaryCanRetry,
  deriveBoundaryStateFromProps,
  describeComponentError,
  initialBoundaryState,
  nextBoundaryRetryState,
  reportComponentError,
} from "../lib/errorRecovery.mjs";

interface ErrorBoundaryProps {
  /// Short section name shown in the fallback ("bounty card", ...).
  label: string;
  /// Changing this clears any failure (navigation, form switch, ...).
  resetKey?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  attempts: number;
  resetKey: string | undefined;
}

/// Isolates render/lifecycle crashes in descendants: one failing card,
/// form, or panel shows a local fallback with recovery instead of
/// blanking the page. Retries are budgeted (see errorRecovery.mjs) so a
/// deterministically failing section ends at a reload hint, not a loop.
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = initialBoundaryState(this.props.resetKey);

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState) {
    return deriveBoundaryStateFromProps({ resetKey: props.resetKey }, state);
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    reportComponentError({
      label: this.props.label,
      error,
      componentStack: info?.componentStack ?? null,
    });
  }

  private retry = () => {
    this.setState((s) => nextBoundaryRetryState(s));
  };

  private reload = () => {
    window.location.reload();
  };

  render() {
    const { error, attempts } = this.state;
    if (!error) return this.props.children;
    const { message } = describeComponentError(error) as { message: string };
    const canRetry = boundaryCanRetry(attempts) as boolean;
    return (
      <div className="notice error" role="alert">
        <strong>Something went wrong loading {this.props.label}.</strong>{" "}
        <span className="muted small">{message}</span>
        <div className="row" style={{ marginTop: 8 }}>
          {canRetry ? (
            <button onClick={this.retry}>Retry {this.props.label}</button>
          ) : (
            <>
              <span className="muted small">This keeps failing — reloading may help.</span>{" "}
              <button onClick={this.reload}>Reload page</button>
            </>
          )}
        </div>
      </div>
    );
  }
}
