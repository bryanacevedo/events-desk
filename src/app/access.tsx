/* Who may see a page, and where a decision is taken, decided in one place so the screens and the tests share it.
   A page the person may not see is refused only once the planners are known: while they load, the page waits. */

import type { Needs } from "./waiting";

/** Where seat and plan decisions are taken on this desk: the panel in the demo, the Slack card when Slack is connected, nowhere otherwise. */
export type Decisions = "panel" | "slack" | "none";
export type Access = "loading" | "yes" | "no";

export const decisionsOf = (h: { demo?: boolean; decisions?: string } | null): Decisions => (h?.demo ? "panel" : h?.decisions === "slack" ? "slack" : h?.decisions === "panel" ? "panel" : "none");

/** The page for planners, leadership and GTM Engineering (Choosing, Results). `lead` is leadership or GTM; `needs` is null until the planners have loaded. */
export const plannerAccess = (needs: Needs | null, actor: string, lead: boolean): Access => (lead ? "yes" : needs === null ? "loading" : needs.planners.includes(actor) ? "yes" : "no");

export const LOADING = "Loading.";
/** A read that finished and brought nothing: this desk does not run that part, which is not the same as one still loading. */
export const NOT_AVAILABLE = (what: string) => `${what} is not available on this desk.`;

/** The line that stands where a decision button would be, when the desk cannot take the decision itself. */
export function DecisionLine({ decisions }: { decisions: Decisions }) {
  if (decisions === "panel") return null;
  return <p className="small mute">{decisions === "slack" ? "Decided in Slack." : "Seat and plan decisions need Slack connected. Nobody can decide this here yet."}</p>;
}

/** What Choosing says when none of its three reads came back: the server decides a refusal, so this never claims one. */
export const CHOOSING_FAILED = "Choosing could not load. Try again.";
