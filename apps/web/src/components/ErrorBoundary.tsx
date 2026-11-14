import { Component, type ErrorInfo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isSignInQuery } from "../lib/auth.js";

interface Props {
  /** A new value (the route's path) clears a caught error, so navigating away recovers. */
  resetKey?: unknown;
  fallback: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

/**
 * A render error stays inside the boundary instead of unmounting the whole app (audit
 * b8-web-layout-08): the shell wraps the routed page in one keyed on the path, and main.tsx wraps
 * the app in another for errors outside the routes.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Pick<State, "error"> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Meridian could not show this page", error, info.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}

/**
 * A page that failed to render, inside the shell (the navigation stays usable). Try again drops
 * the cached responses the page was drawn from, so it loads them afresh; Reload loads the app.
 */
export function PageError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const qc = useQueryClient();
  return (
    <section className="card page-error" role="alert">
      <h1>This page could not be shown</h1>
      <p className="error">{error.message}</p>
      <p className="muted small">The rest of the app still works. Try the page again, or reload the app if this keeps happening.</p>
      <div className="row wrap">
        <button
          type="button"
          onClick={() => {
            void qc.resetQueries({ predicate: (query) => !isSignInQuery(query) });
            onRetry();
          }}
        >
          Try again
        </button>
        <button type="button" className="secondary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </section>
  );
}

/** The app itself failed to render (outside any page). */
export function AppError({ error }: { error: Error }) {
  return (
    <main className="auth-frame">
      <div className="auth-card" role="alert">
        <div className="brand big">Meridian</div>
        <h1>Something went wrong</h1>
        <p className="error">{error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </main>
  );
}
