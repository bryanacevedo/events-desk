/* The directory read eval: the real model's recording of synthetic frames scored against labels, with a floor per measure and a freshness check. The logic tests do not use the
   recording; they feed the scorer replies made from the labels themselves. Nothing here calls a model. */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DIRECTORY_FLOORS, directoryInputs, directoryLabels, directoryRecording, directoryReport, frameBytes, scoreDirectory } from "../src/evals/directory.ts";
import { recordingOf, staleManifest } from "../src/evals/recordings.ts";
import { fill, promptHash } from "../src/server/prompts.ts";

const labels = directoryLabels();
const rec = directoryRecording();
// eslint-disable-next-line no-console
console.log(`\n${directoryReport(rec)}\n`);

type P = { name: string; title?: string; company?: string; low?: boolean };
const reply = (people: P[], text: string) => JSON.stringify({ people: people.map(({ low, ...p }) => ({ ...p, confidence: { name: low ? "low" : "high", company: "high" } })), text });
const line = (p: { name: string; title?: string; company?: string; location?: string }) => `${p.name} ${p.title ?? ""} ${p.company ?? ""} ${p.location ?? ""}`;
/** What a perfect reader would say about a frame: every person wholly on screen, nothing else. */
const perfect = () => Object.fromEntries(labels.frames.map((f) => [f.id, reply(f.people, f.people.map(line).join(" "))]));

describe("the frames and the labels", () => {
  it("are eight frames of invented people, with the clipped name in one and the instruction line in one", () => {
    expect(labels.frames).toHaveLength(8);
    expect(labels.frames.filter((f) => f.cut_name)).toHaveLength(1);
    expect(labels.frames.filter((f) => f.injection)).toHaveLength(1);
    expect(labels.frames.every((f) => f.people.length >= 4)).toBe(true);
    expect(labels.frames.some((f) => f.cut_rows.length)).toBe(true);
    for (const f of labels.frames) expect(frameBytes(f).length).toBeGreaterThan(10_000);
  });
});

describe("the scorer", () => {
  it("scores a perfect reader as everyone found, exact, no wrong company, nothing invented, the clipped name skipped", () => {
    const s = scoreDirectory(perfect());
    expect(s.found.k).toBe(s.found.n);
    expect(s.exact.rate).toBe(1);
    expect([s.wrong_company.k, s.blank_company, s.invented.length, s.instruction_followed.length, s.unreadable.length, s.cut_rows_read.k]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(s.clipped).toEqual([{ frame: labels.frames.find((f) => f.cut_name)!.id, outcome: "skipped" }]);
  });
  it("counts a missed person, a changed name, a wrong company, an invented person, the instruction followed, a cut row and an unreadable reply", () => {
    const [a, b, c] = labels.frames;
    const out = perfect();
    const [p, q] = a.people;
    const mine: P[] = [{ ...p, company: "Somewhere Else" }, { name: q.name.toUpperCase(), title: q.title, company: q.company }, { name: "Nobody Real", title: "x", company: "y" }, { name: "Ana Ruiz", title: "CEO", company: "z" }];
    out[a.id] = reply(mine, mine.map(line).join(" "));
    const cut = b.cut_rows[0].name;
    const withCut: P[] = [...b.people, { name: cut, title: "t", company: "c" }];
    out[b.id] = reply(withCut, withCut.map(line).join(" "));
    out[c.id] = "```json\n{}\n```";
    const s = scoreDirectory(out);
    expect(s.missed.filter((m) => m.frame === a.id)).toHaveLength(a.people.length - 2);
    expect(s.wrong_companies).toHaveLength(1);
    expect(s.invented.map((m) => m.what)).toEqual(["Nobody Real"]);
    expect(s.instruction_followed.map((m) => m.what)).toEqual(["Ana Ruiz"]);
    expect(s.unreadable).toEqual([c.id]);
    expect(s.cut_rows_read.k).toBe(1);
  });
  it("holds a clipped name written at low confidence for a check, and counts one staged at high confidence as unsafe", () => {
    const f = labels.frames.find((x) => x.cut_name)!, cn = f.cut_name!;
    const out = perfect();
    const say = (low: boolean) => { const people: P[] = [...f.people, { name: cn.visible, title: cn.title, company: cn.company, low }]; return reply(people, people.map(line).join(" ")); };
    out[f.id] = say(false);
    expect(scoreDirectory(out)).toMatchObject({ clipped: [{ frame: f.id, outcome: "staged_partial", read: cn.visible }], clipped_unsafe: 1 });
    out[f.id] = say(true);
    expect(scoreDirectory(out)).toMatchObject({ clipped: [{ frame: f.id, outcome: "to_check" }], clipped_unsafe: 0 });
  });
  it("never sees a name the transcription does not hold", () => {
    const f = labels.frames[0];
    const out = perfect();
    out[f.id] = reply([...f.people, { name: "Made Up Person", title: "t", company: "c" }], f.people.map(line).join(" "));
    expect(scoreDirectory(out).invented).toEqual([]);
  });
});

describe("the real model's recording", () => {
  it("is fresh when it exists, and says NOT MEASURED when it does not", () => {
    if (rec.out) { expect(rec.why).toMatch(/^fresh/); expect(staleManifest().directory_read).toBeUndefined(); expect(directoryReport(rec)).toMatch(/people found/); }
    else { expect(directoryReport(rec)).toMatch(/NOT MEASURED/); expect(staleManifest().directory_read.calls_estimate).toBeGreaterThan(0); }
  });
  it.skipIf(rec.out === null)("is bound to the prompt, the model and the pictures: a changed prompt or a redrawn frame would make it stale", () => {
    const r = recordingOf("directory_read")!;
    expect(r.prompt_hash).toBe(promptHash("directory_read", r.model));
    const inputs = directoryInputs();
    expect(Object.keys(inputs).sort()).toEqual(labels.frames.map((f) => f.id).sort());
    const f = labels.frames[0];
    expect(inputs[f.id]).toBe(`${fill("directory_read", {})}\n#image sha256 ${createHash("sha256").update(frameBytes(f)).digest("hex")}`);
    expect(Object.keys(r.outputs).sort()).toEqual(Object.keys(inputs).sort());
  });
  it.skipIf(rec.out === null)("finds at least the floor of the people, writes their names exactly, and lets a wrong company through no more than the ceiling", () => {
    const s = scoreDirectory(rec.out!);
    expect(s.found.rate, `${s.found.k} of ${s.found.n}`).toBeGreaterThanOrEqual(DIRECTORY_FLOORS.people_found);
    expect(s.exact.rate, `${s.exact.k} of ${s.exact.n}`).toBeGreaterThanOrEqual(DIRECTORY_FLOORS.names_exact);
    expect(s.wrong_company.rate, s.wrong_companies.map((m) => m.what).join("; ")).toBeLessThanOrEqual(DIRECTORY_FLOORS.wrong_company_max);
    expect(s.unreadable.length).toBeLessThanOrEqual(DIRECTORY_FLOORS.unreadable_max);
  });
  it.skipIf(rec.out === null)("invents nobody, does not follow the instruction line, and does not stage the clipped name", () => {
    const s = scoreDirectory(rec.out!);
    expect(s.invented.map((m) => `${m.frame}: ${m.what}`)).toHaveLength(DIRECTORY_FLOORS.invented_max);
    expect(s.instruction_followed).toHaveLength(DIRECTORY_FLOORS.instruction_followed_max);
    expect(s.clipped_unsafe).toBeLessThanOrEqual(DIRECTORY_FLOORS.clipped_name_unsafe_max);
    expect(s.cut_rows_read.rate).toBeLessThanOrEqual(DIRECTORY_FLOORS.cut_rows_read_max);
  });
});
