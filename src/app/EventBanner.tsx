/* An event's header band: its logo at a confident size, the name, when and where, who is going.
   The organizer's brand color (catalog_events.brand_color) tints the band and draws its edge, so
   events stop blending into each other while the page stays white and calm. Text stays ink on a
   tint light enough for AA; an unknown color falls back to the Desk green. */

import type { CSSProperties, ReactNode } from "react";
import { Link } from "./App";
import { EventLogo } from "./EventLogo";
import { shortDate } from "./words";

export function EventBanner({ name, website, brandColor, startsOn, place, going = 0, waiting = 0, flag, to, go, children }: {
  name: string; website?: string | null; brandColor?: string | null; startsOn: string; place?: string | null;
  going?: number; waiting?: number; flag?: ReactNode; to?: string; go?: (to: string) => void; children?: ReactNode;
}) {
  const style = brandColor ? ({ "--brand": brandColor } as CSSProperties) : undefined;
  const meta = [shortDate(startsOn), place, going ? `${going} going` : "", waiting ? `${waiting} waiting` : ""].filter(Boolean);
  return (
    <div className="banner" style={style}>
      <EventLogo name={name} website={website} size={44} />
      <div className="banner-text">
        <h2 className="display">{to && go ? <Link to={to} go={go}>{name}</Link> : name}</h2>
        <p className="banner-meta small">{meta.map((m, i) => <span key={i}>{m}</span>)}</p>
      </div>
      {flag && <div className="banner-fig">{flag}</div>}
      {children}
    </div>
  );
}
