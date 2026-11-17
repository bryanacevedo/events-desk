/* A deploy renames every page's file. A tab that was open before it asks for a page by its old name and the import fails; with nothing to catch it the whole app unmounted to a blank screen.
   Two nets: Vite's `vite:preloadError` (a chunk that cannot be fetched) and an error boundary (a lazy page that threw while loading). Both reload the page once, which fetches the new build;
   a second failure inside a minute shows a sentence and a button instead of looping. */
import { Component, type ReactNode } from "react";

const KEY = "chunk-reload-at";
const WINDOW_MS = 60_000;

/** True when the error is a page file that could not be loaded (the browsers word it differently). */
export function isChunkError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(m);
}

/** Reloads once per minute. Returns false when it already did, so the caller shows the fallback instead. */
export function reloadOnce(now = Date.now(), reload: () => void = () => location.reload()): boolean {
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY) ?? 0); } catch { /* storage blocked: reload at most this once per page load */ }
  if (now - last < WINDOW_MS) return false;
  try { sessionStorage.setItem(KEY, String(now)); } catch { /* ignore */ }
  reload();
  return true;
}

export function watchChunkErrors() {
  window.addEventListener("vite:preloadError", (ev) => { if (reloadOnce()) ev.preventDefault(); });
}

export class ChunkGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { if (isChunkError(e)) reloadOnce(); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={{ padding: "48px 24px", maxWidth: 520, margin: "0 auto" }}>
        <p>This page could not load. The desk was probably updated while it was open.</p>
        <button type="button" className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
