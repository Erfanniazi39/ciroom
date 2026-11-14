import { Component, type ReactNode } from "react";
import { ErrorState } from "@/components/States";

/** Catches a render crash below it so one broken page doesn't blank the whole window. Remount it (via `key`) to reset. */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: (message: string, retry: () => void) => ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("[ciroom] page crashed:", error); }
  private retry = () => this.setState({ error: null });
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const msg = error.message || "This page crashed.";
    return this.props.fallback ? this.props.fallback(msg, this.retry) : <ErrorState message={msg} onRetry={this.retry} />;
  }
}
