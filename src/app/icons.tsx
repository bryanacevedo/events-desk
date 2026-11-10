/* The brand mark and the tab icons, one set: 20px box, 1.6 stroke, round joins. Inline, no dependency. */

const base = { width: 20, height: 20, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };

export const Icon = {
  overview: () => <svg {...base}><path d="M3 5.5h14M3 10h9M3 14.5h11" /></svg>,
  events: () => <svg {...base}><path d="M3.5 7.5V5.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-2a2 2 0 0 0 0-4Z" /><path d="M8 7.5v1M8 11.5v1" /></svg>,
  seats: () => <svg {...base}><circle cx="10" cy="10" r="7" /><path d="m6.8 10.2 2.2 2.2 4.4-4.8" /></svg>,
  budget: () => <svg {...base}><path d="M3 15.5h14" /><rect x="4.5" y="9" width="2.6" height="6.5" rx="0.6" /><rect x="8.7" y="5.5" width="2.6" height="10" rx="0.6" /><rect x="12.9" y="7.5" width="2.6" height="8" rx="0.6" /></svg>,
  results: () => <svg {...base}><path d="M5.5 17V3.5" /><path d="M5.5 4h9.5l-2.2 3.2L15 10.5H5.5" /></svg>,
  usage: () => <svg {...base}><path d="M3 14.5 7.5 9l3 3 6-7" /><path d="M13.5 5h3v3" /></svg>,
  more: () => <svg {...base}><circle cx="5" cy="10" r="1.2" /><circle cx="10" cy="10" r="1.2" /><circle cx="15" cy="10" r="1.2" /></svg>,
  calendar: () => <svg {...base}><rect x="3" y="4.5" width="14" height="12.5" rx="2" /><path d="M3 8.5h14M7 2.8v3M13 2.8v3" /></svg>,
  reply: () => <svg {...base}><path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H9l-3.5 3v-3h0a2 2 0 0 1-2-2Z" /><path d="M7 8.8h6" /></svg>,
  pin: () => <svg {...base}><path d="M10 17.5s5.5-5 5.5-9.3a5.5 5.5 0 0 0-11 0c0 4.3 5.5 9.3 5.5 9.3Z" /><circle cx="10" cy="8.2" r="1.9" /></svg>,
  people: () => <svg {...base}><circle cx="7.5" cy="7" r="2.8" /><path d="M2.5 16.5c.4-3 2.4-4.6 5-4.6s4.6 1.6 5 4.6" /><path d="M13 4.6a2.6 2.6 0 0 1 0 4.9M14.8 12.3c1.5.6 2.4 2 2.7 4.2" /></svg>,
  next: () => <svg {...base}><circle cx="10" cy="10" r="7" /><path d="M7 10h5.5M10.3 7.5l2.5 2.5-2.5 2.5" /></svg>,
  history: () => <svg {...base}><path d="M3.6 10a6.5 6.5 0 1 0 1.9-4.6L3.5 7.4" /><path d="M3.5 3.8v3.6h3.6M10 6.8V10l2.2 1.4" /></svg>,
  cost: () => <svg {...base}><path d="M5 3h10v14l-2-1.3-1.5 1.3L10 15.7 8.5 17 7 15.7 5 17V3Z" /><path d="M8 7h4M8 10.5h4" /></svg>,
  target: () => <svg {...base}><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3" /><path d="M10 1.8v3M10 15.2v3M1.8 10h3M15.2 10h3" /></svg>,
  grid: () => <svg {...base}><rect x="3" y="3" width="6" height="6" rx="1.2" /><rect x="11" y="3" width="6" height="6" rx="1.2" /><rect x="3" y="11" width="6" height="6" rx="1.2" /><rect x="11" y="11" width="6" height="6" rx="1.2" /></svg>,
  lists: () => <svg {...base}><path d="M7.5 5.5H17M7.5 10H17M7.5 14.5H17" /><path d="M3 5.5h.6M3 10h.6M3 14.5h.6" /></svg>,
  check: () => <svg {...base}><path d="M10 2.5 16 5v4.6c0 3.8-2.5 6.4-6 7.9-3.5-1.5-6-4.1-6-7.9V5l6-2.5Z" /><path d="m7.4 10 1.9 1.9 3.4-3.7" /></svg>,
  plug: () => <svg {...base}><path d="M7 2.8v4M13 2.8v4M5 6.8h10v2.4a5 5 0 0 1-10 0V6.8ZM10 14.2v3" /></svg>,
  settings: () => <svg {...base}><path d="M3 6.5h14M3 13.5h14" /><circle cx="8" cy="6.5" r="2" fill="var(--ground)" /><circle cx="12.5" cy="13.5" r="2" fill="var(--ground)" /></svg>,
};

/** Events Desk: a ticket on a desk. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 18.5h18M6.5 18.5v3M17.5 18.5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5.5 7.5a1.5 1.5 0 0 1 1.5-1.5h10a1.5 1.5 0 0 1 1.5 1.5v2.1a1.4 1.4 0 0 0 0 2.8v2.1a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5v-2.1a1.4 1.4 0 0 0 0-2.8Z" fill="#1F5D3F" />
      <path d="M11 8.5v1M11 11.5v1M11 14.5v1" stroke="#FFFFFF" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
