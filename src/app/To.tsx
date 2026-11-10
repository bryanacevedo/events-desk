/* Links to the things a screen names: a person opens on their event's People view with their panel open, a company opens the
   Companies table filtered to it, an event opens its page. Anything that names one of these is a way to it. */

import type { ReactNode } from "react";
import { Link, useActor } from "./App";

export const personHref = (eventId: string, contactId: string, name?: string | null) => `/event/${eventId}?person=${encodeURIComponent(contactId)}${name ? `&q=${encodeURIComponent(name)}` : ""}#people`;
export const companyHref = (eventId: string, company: string) => `/event/${eventId}?by=companies&cq=${encodeURIComponent(company)}#people`;
export const eventHref = (eventId: string, view?: "outreach" | "people" | "details") => `/event/${eventId}${view ? `#${view}` : ""}`;

/** An in-app link with no visible chrome: the thing itself is the link, and it underlines on hover. */
export function To({ to, children, className = "", label }: { to: string | null; children: ReactNode; className?: string; label?: string }) {
  const { go } = useActor();
  if (!to) return <>{children}</>;
  return <Link to={to} go={go} className={`to ${className}`} aria-label={label}>{children}</Link>;
}
