/* The one edit to the gate (docs/DIRECTORY.md 3 and 13.11): the countries the desk does not email are refused on email for everyone, whatever the source of the list. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { runGate } from "../src/server/gate.ts";
import { recordLegalBasis } from "../src/server/sequences.ts";
import { gateWords } from "../src/shared/gate-words.ts";
import defaults from "../config/defaults.json" with { type: "json" };
import { deliveredInMotion, MAYA, personAt, type Harness } from "./lifecycle-harness.ts";
import { freshDb } from "./helpers.ts";

const BLOCKED = defaults.email_country_rules.blocked as string[];
/** A city-free place a person's profile would carry, by country. */
const PLACE: Record<string, string> = { IT: "Milan, Italy", CH: "Zurich, Switzerland", SE: "Stockholm, Sweden", DK: "Copenhagen, Denmark", BE: "Brussels, Belgium", AT: "Vienna, Austria", NO: "Oslo, Norway", DE: "Berlin, Germany" };

let db: Db, h: Harness;
beforeEach(async () => { db = await freshDb(); h = await deliveredInMotion(db); });

const gate = async (name: string, channel: "email" | "linkedin" = "email") => (await runGate(db, h.deps, h.id, [(await personAt(db, h.id, name)).id], channel, "add"))[0];
const place = async (name: string, where: string | null, source = "web_app_download") => db.query("UPDATE contacts SET person_location = $2, list_source = $3 WHERE event_id = $1 AND full_name = $4", [h.id, where, source, name]);

describe("country_blocked", () => {
  it("refuses each blocked country on email, and not on LinkedIn", async () => {
    expect(BLOCKED.sort()).toEqual(Object.keys(PLACE).sort());
    await recordLegalBasis(db, h.id, "GTM Team", "austria", "Counsel confirmed");
    await place("Ana Ruiz", PLACE.AT);
    expect((await gate("Ana Ruiz", "linkedin")).passed).toBe(true);
    for (const c of BLOCKED) {
      await place("Ana Ruiz", PLACE[c]);
      const email = await gate("Ana Ruiz");
      expect(email, c).toMatchObject({ passed: false, reason: "country_blocked" });
      // LinkedIn still needs a recorded basis for the region, as before; what it never gets is this reason.
      expect((await gate("Ana Ruiz", "linkedin")).reason, c).not.toBe("country_blocked");
    }
  });
  it("is refused even when a contact basis is recorded for that region", async () => {
    await recordLegalBasis(db, h.id, "GTM Team", "italy", "Counsel confirmed");
    await place("Ana Ruiz", "Milan, Italy");
    expect((await gate("Ana Ruiz")).reason).toBe("country_blocked");
  });
  it("takes a country by its native name, and a company's country when the person has no place", async () => {
    await place("Ana Ruiz", "München, Deutschland");
    expect((await gate("Ana Ruiz")).reason).toBe("country_blocked");
    await place("Ana Ruiz", null);
    await db.query("UPDATE companies SET firmo = '{\"country\": \"Sverige\"}'::jsonb WHERE event_id = $1 AND name = 'Tallgrass Software'", [h.id]);
    expect((await gate("Ana Ruiz")).reason).toBe("country_blocked");
    expect((await gate("Ben Ode")).reason).toBe("country_blocked");
    expect((await gate("Cleo Park")).passed).toBe(true);
  });
  it("leaves an unlisted country to the contact-basis check as before, and an unknown place too", async () => {
    await place("Ana Ruiz", "Paris, France");
    expect((await gate("Ana Ruiz")).reason).toBe("no_legal_basis");
    await recordLegalBasis(db, h.id, MAYA, "france", "Legitimate interest");
    expect((await gate("Ana Ruiz")).passed).toBe(true);
    await place("Ana Ruiz", "Atlantis");
    await db.query("DELETE FROM legal_bases WHERE region = 'atlantis'");
    expect((await gate("Ana Ruiz")).reason).toBe("no_legal_basis");
    await place("Ana Ruiz", null);
    expect((await gate("Ana Ruiz")).passed).toBe(true);
  });
  it("is the same answer for the same person from every source", async () => {
    const answers: Record<string, unknown[]> = {};
    for (const source of ["web_app_download", "directory_extension", "screen_recording", "other"]) {
      const out: unknown[] = [];
      for (const where of ["Milan, Italy", "Paris, France", null]) {
        await place("Ana Ruiz", where, source);
        const e = await gate("Ana Ruiz"), l = await gate("Ana Ruiz", "linkedin");
        out.push([e.passed, e.reason, l.passed, l.reason]);
      }
      answers[source] = out;
    }
    expect(answers.directory_extension).toEqual(answers.web_app_download);
    expect(answers.screen_recording).toEqual(answers.web_app_download);
    expect(answers.other).toEqual(answers.web_app_download);
  });
  it("names no source in any reason, and says it in words", async () => {
    await place("Ana Ruiz", "Milan, Italy", "directory_extension");
    const r = await gate("Ana Ruiz");
    expect(r.reason).toBe("country_blocked");
    expect(gateWords("country_blocked")).toBe("not emailed in their country");
    const logged = await db.query<{ reason: string }>("SELECT reason FROM gate_log WHERE reason IS NOT NULL");
    for (const row of logged) expect(row.reason).not.toMatch(/directory|recording|extension|source/);
    expect(gateWords("gate:country_blocked")).toBe("not emailed in their country");
  });
  it("Germany's basis can still be recorded only by GTM Engineering, and being recorded does not lift the block", async () => {
    await expect(recordLegalBasis(db, h.id, MAYA, "germany", "x")).rejects.toThrow(/GTM Engineering records this one/);
    await recordLegalBasis(db, h.id, "GTM Team", "germany", "Counsel confirmed");
    await place("Ana Ruiz", "Berlin, Germany");
    expect((await gate("Ana Ruiz")).reason).toBe("country_blocked");
  });
  it("a refusal on the email channel is written to the gate log with its reason", async () => {
    await place("Ana Ruiz", "Oslo, Norway");
    await gate("Ana Ruiz");
    expect((await db.query<any>("SELECT passed, reason, channel FROM gate_log WHERE contact_id = $1 ORDER BY at DESC LIMIT 1", [(await personAt(db, h.id, "Ana Ruiz")).id]))[0]).toMatchObject({ passed: false, reason: "country_blocked", channel: "email" });
  });
});
