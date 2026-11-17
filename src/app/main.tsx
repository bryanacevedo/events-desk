import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/geist";
import "./styles.css";
import { ChunkGuard, watchChunkErrors } from "./ChunkGuard";

// A guest's own RSVP link is its own page: no desk, no acting-as choice, no write key. Everything else is the desk.
watchChunkErrors();
const root = createRoot(document.getElementById("root")!);
if (/^\/rsvp\/[^/]+\/?$/.test(location.pathname)) import("./Rsvp").then(({ Rsvp }) => root.render(<StrictMode><ChunkGuard><Rsvp /></ChunkGuard></StrictMode>));
else if (/^\/scan\/[^/]+\/?$/.test(location.pathname)) import("../scan/ScanApp").then(({ ScanApp }) => root.render(<StrictMode><ChunkGuard><ScanApp /></ChunkGuard></StrictMode>));
else import("./App").then(({ App }) => root.render(<StrictMode><ChunkGuard><App /></ChunkGuard></StrictMode>));
