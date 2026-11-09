/* An event's mark: its organizer's logo on a white tile, read at view time from Google's favicon
   service for the event's website domain. Nothing is downloaded or stored. When the domain has no
   usable icon (none, tiny, or one of the few known to be a blank shape) the tile shows initials in
   Desk colors instead, so a row never carries a poor image. */

import { useState } from "react";

/** The domain a logo is looked up by, from a website URL. Null when there is no usable URL. */
export function logoDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try { return new URL(website).hostname.replace(/^www\./, "").toLowerCase() || null; } catch { return null; }
}

/** Domains whose favicon is a blank shape or too small to read; they get the initials tile. Checked by eye against the demo's events. */
const POOR = new Set(["merchantriskcouncil.org", "finnosummit.com", "money2020.com"]);
/** Google returns a 16px placeholder for unknown sites; anything that small is not a logo. */
const MIN_PX = 24;

export const eventInitials = (name: string) => {
  const words = name.replace(/\(.*?\)/g, "").split(/[\s:]+/).filter((w) => w && !/^(the|and|of|de|do|da|x|20\d\d)$/i.test(w));
  return (words.slice(0, 2).map((w) => w[0]).join("") || name.slice(0, 1)).toUpperCase();
};

export function EventLogo({ name, website, size = 28, className = "" }: { name: string; website?: string | null; size?: number; className?: string }) {
  const domain = logoDomain(website);
  const [failed, setFailed] = useState(false);
  const usable = domain && !POOR.has(domain) && !failed;
  const px = `${size}px`;
  return (
    <span className={`logo${usable ? "" : " fallback"} ${className}`.trim()} style={{ width: px, height: px, fontSize: Math.round(size * 0.38) }} aria-hidden="true" data-domain={domain ?? undefined}>
      {usable
        ? <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`} alt="" loading="lazy" decoding="async" width={size} height={size}
            onError={() => setFailed(true)} onLoad={(ev) => { if (ev.currentTarget.naturalWidth < MIN_PX) setFailed(true); }} />
        : eventInitials(name)}
    </span>
  );
}
