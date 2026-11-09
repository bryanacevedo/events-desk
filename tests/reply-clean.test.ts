import { describe, expect, it } from "vitest";
import { cleanReply } from "../src/shared/reply-clean.ts";

describe("what the person typed", () => {
  it("leaves plain text alone", () => expect(cleanReply("Sounds good.\nTuesday works.")).toBe("Sounds good.\nTuesday works."));
  it("handles nothing", () => { expect(cleanReply(null)).toBe(""); expect(cleanReply("   ")).toBe(""); });

  it.each([
    ["English", "Yes please\n\nOn Tue, Jan 12, 2027 at 9:00 AM Maya Ortiz <m@x.example> wrote:\n> Hi Ana"],
    ["Spanish", "Yes please\n\nEl mar, 12 ene 2027 a las 9:00, Maya Ortiz escribió:\n> Hola"],
    ["German", "Yes please\n\nAm 12.01.2027 um 09:00 schrieb Maya Ortiz <m@x.example>:\n> Hallo"],
    ["French", "Yes please\n\nLe mar. 12 janv. 2027 à 09:00, Maya Ortiz a écrit :\n> Salut"],
    ["Outlook", "Yes please\n\n________________________________\nFrom: Maya Ortiz\nSent: Tuesday\nTo: Ana"],
    ["forwarded", "Yes please\n\n---------- Forwarded message ---------\nFrom: x"],
  ])("cuts the quoted thread (%s)", (_l, body) => expect(cleanReply(body)).toBe("Yes please"));

  it("drops quoted lines in the middle, keeping what was typed around them", () => expect(cleanReply("Great\n> your pitch\nCall me")).toBe("Great\n\nCall me".replace("\n\n", "\n")));
  it("stops at a signature", () => { expect(cleanReply("Yes\n-- \nAna Ruiz\nVP")).toBe("Yes"); expect(cleanReply("Yes\nSent from my iPhone")).toBe("Yes"); });

  it("removes an unsubscribe footer, so it cannot act as a request", () => {
    expect(cleanReply("Interested, tell me more\nTo unsubscribe click here: https://x.example/u")).toBe("Interested, tell me more");
    expect(cleanReply("Interested\nIf you no longer wish to receive these emails, reply STOP")).toBe("Interested");
  });

  it("keeps a real request to stop", () => {
    expect(cleanReply("Please unsubscribe me")).toBe("Please unsubscribe me");
    expect(cleanReply("Take me off this list.")).toBe("Take me off this list.");
  });

  it("a reply that is only a quote is empty", () => expect(cleanReply("> old text\n> more")).toBe(""));
});
