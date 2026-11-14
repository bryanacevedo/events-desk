/* The scanner's pure parts (docs/SCANNER.md 5): what a badge code says, who is nearly the same person, the CSV guard and the photo's type. */

import { describe, expect, it } from "vitest";
import { classifyPayload, csvCell, csvRow, imageMime, nearMatches, parseMeCard, parseVCard, placeable } from "../src/shared/scan.ts";

describe("vCard", () => {
  it("reads a 3.0 card with escapes and a folded line", () => {
    const v = ["BEGIN:VCARD", "VERSION:3.0", "N:Lima;Ana;;;", "FN:Ana Lima", "ORG:Orrery\\, Inc.;Payments", "TITLE:Head of Payments", "EMAIL;TYPE=WORK:ana.lima@orrery", " .example", "TEL;TYPE=CELL:+351 21 000 0000", "ADR;TYPE=WORK:;;1 Pier;Lisbon;;1000;Portugal", "URL:https://www.linkedin.com/in/ana-lima", "END:VCARD"].join("\r\n");
    expect(parseVCard(v)).toEqual({ name: "Ana Lima", company: "Orrery, Inc.", title: "Head of Payments", email: "ana.lima@orrery.example", phone: "+351 21 000 0000", country: "Portugal", linkedin: "https://www.linkedin.com/in/ana-lima" });
  });
  it("builds a name from N when FN is missing, keeps typos as printed, and never invents a field", () => {
    expect(parseVCard("BEGIN:VCARD\nN:Odé;Ben\nEMAIL:ben@exmaple.com\nEND:VCARD")).toEqual({ name: "Ben Odé", email: "ben@exmaple.com" });
    expect(parseVCard("BEGIN:VCARD\nEND:VCARD")).toEqual({});
  });
});

describe("MeCard", () => {
  it("reads last,first and escaped separators", () => {
    expect(parseMeCard("MECARD:N:Lima,Ana;TEL:+351210000000;EMAIL:ana@orrery.example;ORG:Orrery\\; Lisbon;TITLE:Head of Payments;;")).toEqual({ name: "Ana Lima", phone: "+351210000000", email: "ana@orrery.example", company: "Orrery; Lisbon", title: "Head of Payments" });
  });
});

describe("what a decoded code is", () => {
  it("is a person when it carries one, an id when it is only an id, nothing when it is empty", () => {
    expect(classifyPayload("BEGIN:VCARD\nFN:Ana Lima\nEND:VCARD")).toMatchObject({ kind: "vcard", fields: { name: "Ana Lima" } });
    expect(classifyPayload("MECARD:N:Lima,Ana;;")).toMatchObject({ kind: "mecard" });
    expect(classifyPayload("https://show.example/badge?name=Ana%20Lima&email=ana@orrery.example&company=Orrery")).toMatchObject({ kind: "link", fields: { name: "Ana Lima", email: "ana@orrery.example", company: "Orrery" } });
    expect(classifyPayload("https://show.example/b/9F3K2")).toEqual({ kind: "id", id: "9F3K2" });
    expect(classifyPayload("123456789")).toEqual({ kind: "id", id: "123456789" });
    expect(classifyPayload("   ")).toBeNull();
    expect(classifyPayload("BEGIN:VCARD\nEND:VCARD")).toBeNull();
  });
  it("needs an email, a LinkedIn profile, or a name with a company to place a person", () => {
    expect(placeable({ name: "Ana Lima" })).toBe(false);
    expect(placeable({ name: "Ana Lima", company: "Orrery" })).toBe(true);
    expect(placeable({ email: "a@b.example" })).toBe(true);
    expect(placeable({ email: "not an email" })).toBe(false);
  });
});

describe("near matches", () => {
  const me = { id: "me", name: "Robert Kline", company: "Orrery", email: "robert@orrery.example" };
  it("finds a short form or a typo at the same company, and not a stranger", () => {
    expect(nearMatches(me, [{ id: "a", name: "Rob Kline", company: "Orrery", email: null }]).map((x) => x.id)).toEqual(["a"]);
    expect(nearMatches(me, [{ id: "b", name: "Robert Kilne", company: "Orrery", email: null }]).map((x) => x.id)).toEqual(["b"]);
    expect(nearMatches(me, [{ id: "c", name: "Maya Ortiz", company: "Orrery", email: null }, { id: "d", name: "Rob Kline", company: "Other Co", email: null }])).toEqual([]);
  });
  it("finds the same name written with another company at the same address domain", () => {
    expect(nearMatches(me, [{ id: "e", name: "Robert Kline", company: "Orrery Pay", email: "r.kline@orrery.example" }]).map((x) => x.id)).toEqual(["e"]);
  });
});

describe("the CSV", () => {
  it("quotes what needs it and stops a spreadsheet running a cell", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("+351 21 000 0000")).toBe("+351 21 000 0000");
    expect(csvRow(["a", null, 3])).toBe("a,,3");
  });
});

describe("the photo's type", () => {
  it("comes from its first bytes", () => {
    expect(imageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(imageMime(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});
