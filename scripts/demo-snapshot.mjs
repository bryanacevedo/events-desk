/* Builds samples/demo-snapshot.tgz: the demo's database, seeded and cleanly shut down. */
import { execFileSync, spawn } from "node:child_process";
const port = "8899";
const server = spawn(process.execPath, ["src/server/node.ts", "--demo"], { env: { ...process.env, PORT: port, PUBLIC_DEMO: "", SAMPLE_SHEET_URL: "https://docs.google.com/spreadsheets/d/1bGZTGoRjTo9ag7I1b7ni5VQbTaV5rdsrOQmdUa75Hrg/edit" }, stdio: "ignore" });
for (let i = 0; i < 180; i++) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
// The flagship is taken into market in the background once it is delivered. Wait for that, so the snapshot opens with it.
for (let i = 0; i < 480; i++) {
  try { const m = await (await fetch(`http://localhost:${port}/api/events/evt_money20-20-usa-2026/motion`)).json(); if (m.motion === "in_market" && (m.meetings ?? []).length) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
// Then every other step after delivery: the last two seeded are NRF (scored) and Tokyo (in market before its event).
const motionOf = async (id) => { try { return (await (await fetch(`http://localhost:${port}/api/events/${id}/motion`)).json()).motion; } catch { return null; } };
for (let i = 0; i < 480; i++) {
  if ((await motionOf("evt_nrf-2026-retail-s-big-show")) === "scored" && (await motionOf("evt_salesforce-world-tour-tokyo-2026")) === "in_market") break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 3000));
await new Promise((r) => setTimeout(r, 2000));
await new Promise((r) => { server.on("exit", r); server.kill("SIGTERM"); });
execFileSync("tar", ["--no-mac-metadata", "--no-xattrs", "-czf", "samples/demo-snapshot.tgz", "-C", ".data", "demo"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
console.log("samples/demo-snapshot.tgz written");
