import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/geist";
import "./styles.css";

// A guest's own RSVP link is its own page: no desk, no acting-as choice, no write key. Everything else is the desk.
const root = createRoot(document.getElementById("root")!);
if (/^\/rsvp\/[^/]+\/?$/.test(location.pathname)) import("./Rsvp").then(({ Rsvp }) => root.render(<StrictMode><Rsvp /></StrictMode>));
else import("./App").then(({ App }) => root.render(<StrictMode><App /></StrictMode>));
