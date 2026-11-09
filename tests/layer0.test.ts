import { describe, expect, it } from "vitest";
import { mapColumns, normalize, parseCsv } from "../src/shared/ingest.ts";
import { classifyEmail, cleanRow, cleanWebsite, isMash, isWebmailTypo, looksLikeTitle, type RawRow } from "../src/shared/layer0.ts";

const row = (o: Partial<RawRow>): RawRow => ({ company: "", first: "", last: "", full: "", title: "", email: "", linkedin: "", website: "", badge: "", ...o });
const run = (csv: string) => { const p = parseCsv(csv); const m = mapColumns(p); return normalize(p, m.map, m.extras); };

describe("keyboard mash", () => {
  it("never touches short all-capital names", () => {
    for (const name of ["KPMG", "HSBC", "DHL", "AAA", "IBM", "SAP", "BASF", "XXX", "ZZZZ"]) expect(isMash(name), name).toBe(false);
    for (const name of ["KPMG", "HSBC", "DHL", "AAA"]) {
      const c = cleanRow(row({ company: name, email: "a@x.example" }));
      expect(c.company).toBe(name);
      expect(c.issues).not.toContain("company_mash");
    }
  });
  it("blanks a value only when every word is certainly mash", () => {
    for (const v of ["qqqq www", "zzzz", "hhhh", "xxxxx", "jjjjjj", "asdf", "qwerty", "sdfg", "jkl", "wer", "xxx"]) expect(isMash(v), v).toBe(true);
    for (const v of ["Acme", "Zzyzx Labs", "Ng", "Li", "Xu", "Wesson", "Dell", "Asda", "Qwest", "Lumdu", "3M", "Sdfg Software", "Hjk Logistics"]) expect(isMash(v), v).toBe(false);
  });
  it("leaves a doubtful value for Research", () => {
    expect(cleanRow(row({ company: "Qxbvtr Holdings", email: "a@x.example" })).company).toBe("Qxbvtr Holdings");
  });
  it("blanks a mashed name field but keeps the person's email", () => {
    const c = cleanRow(row({ company: "Lumdu", first: "jkl", last: "wer", email: "andres@lumdu.example" }));
    expect(c.first).toBe("");
    expect(c.last).toBe("");
    expect(c.email).toBe("andres@lumdu.example");
  });
});

describe("filler", () => {
  it("treats N/A, dashes and none as blank in company, title and email", () => {
    const c = cleanRow(row({ company: "N/A", title: "-", email: "n/a", first: "Ann", last: "Lee" }));
    expect(c.company).toBe("");
    expect(c.title).toBe("");
    expect(c.email).toBeNull();
    expect(c.issues).toEqual(expect.arrayContaining(["company_filler", "title_filler", "email_filler"]));
  });
  it("treats en and em dashes as blank", () => {
    const c = cleanRow(row({ company: "\u2014", title: "\u2013", first: "Ann", last: "Lee", email: "a@x.example" }));
    expect(c.company).toBe("");
    expect(c.title).toBe("");
  });
  it("does not read a real surname as filler", () => {
    expect(cleanRow(row({ company: "Acme", first: "Min", last: "Na" })).last).toBe("Na");
    expect(cleanRow(row({ company: "Acme", first: "Soo", last: "No" })).last).toBe("No");
  });
});

describe("placeholder and webmail addresses", () => {
  it("discards a placeholder domain and lets the row continue on name and company", () => {
    const c = cleanRow(row({ company: "Acme", full: "Ann Lee", email: "x@asdf.com" }));
    expect(c.email).toBeNull();
    expect(c.issues).toContain("placeholder_email");
    expect(c.company).toBe("Acme");
  });
  it("knows free webmail and a mistyped one, and does not call a company domain either", () => {
    expect(classifyEmail("a@gmail.com").kind).toBe("free_webmail");
    expect(classifyEmail("a@gmial.com").kind).toBe("webmail_typo");
    expect(classifyEmail("a@acme.example").kind).toBe("ok");
    expect(isWebmailTypo("gmail.com")).toBe(false);
    expect(isWebmailTypo("gmailer.example")).toBe(false);
  });
  it("ignores filler and placeholder websites, and keeps a real one", () => {
    for (const w of ["-", "N/A", "none", "www", "http://", ".com", "www.test.com", "company.com", "gmail.com"]) expect(cleanWebsite(w).domain, w).toBeNull();
    expect(cleanWebsite("https://www.acme.example/en").domain).toBe("acme.example");
    expect(cleanWebsite("acme.example").domain).toBe("acme.example");
  });
});

describe("one email on several people", () => {
  const csv = "Company,Name,Email\nBretam,Amal Al-Farsi,events@bretam.example\nBretam,Hala Shaheen,events@bretam.example\nBretam,Hassan Haddadin,events@bretam.example\nAcme,Zed Ray,zed@acme.example\n";
  it("discards the email for each of them, and every person continues instead of being dropped as a duplicate", () => {
    const out = run(csv);
    const bretam = out.contacts.filter((c) => c.company_key === "bretam");
    expect(bretam).toHaveLength(3);
    for (const c of bretam) { expect(c.email).toBeNull(); expect(c.drop_reason).toBeNull(); }
    expect(out.contacts.find((c) => c.full_name === "Zed Ray")!.email).toBe("zed@acme.example");
    expect(out.quality.shared_emails).toEqual({ emails: 1, rows: 3 });
  });
  it("still drops one person listed twice on their own address", () => {
    const out = run("Company,Name,Email\nAcme,Ann Lee,ann@acme.example\nAcme,Lee Ann,ann@acme.example\n");
    expect(out.contacts.map((c) => c.drop_reason)).toEqual([null, "duplicate"]);
    expect(out.quality.shared_emails.emails).toBe(0);
  });
  it("treats a typo in the name as the same person, not as a shared mailbox", () => {
    const out = run("Company,Name,Email\nAcme,Lena Lüdke,lena@acme.example\nAcme,Lena Ludke,lena@acme.example\n");
    expect(out.contacts.map((c) => c.drop_reason)).toEqual([null, "duplicate"]);
  });
});

describe("one domain across unrelated companies", () => {
  const unrelated = ["Alder Freight", "Birch Pay", "Cedar Foods", "Dune Labs"].map((c, i) => `${c},P${i} Name${i},p${i}@pavilion.example`).join("\n");
  it("identifies nobody: not offered as evidence for any company", () => {
    const out = run(`Company,Name,Email\n${unrelated}\n`);
    expect(out.quality.shared_domains.domains).toEqual(["pavilion.example"]);
    for (const co of out.companies) expect(co.evidence.filter((e) => e.source === "email_domain")).toEqual([]);
    expect(out.contacts.every((c) => c.email)).toBe(true);
  });
  it("keeps a real domain that a few spellings and one new employer share", () => {
    const out = run("Company,Name,Email\nFlintbay Works,A One,a@flintbay.example\nFLINTBAY WORKS INC,B Two,b@flintbay.example\nFlintbay Wroks,C Three,c@flintbay.example\nOld Employer Ltd,D Four,d@flintbay.example\n");
    expect(out.quality.shared_domains.domains).toEqual([]);
    expect(out.companies.find((c) => c.key === "flintbay works")!.evidence[0]).toMatchObject({ source: "email_domain", value: "flintbay.example" });
  });
  it("does not call a subsidiary on its parent's domain unrelated", () => {
    const out = run("Company,Name,Email\nSparrowgate,A One,a@sparrowgate.example\nSparrowgate Legal,B Two,b@sparrowgate.example\nSparrowgate Capital,C Three,c@sparrowgate.example\n");
    expect(out.quality.shared_domains.domains).toEqual([]);
  });
});

describe("a person's name as company, and non-companies", () => {
  it("treats the person's own name, in either order, as no company", () => {
    expect(cleanRow(row({ company: "García, Joaquín", first: "Joaquín", last: "García", email: "j@x.example" })).company).toBe("");
    expect(cleanRow(row({ company: "Signe Öztürk", first: "Signe", last: "Öztürk", email: "j@x.example" })).issues).toContain("person_name_as_company");
    expect(cleanRow(row({ company: "Ralph Lauren", first: "Ralph", last: "Smith", email: "j@x.example" })).company).toBe("Ralph Lauren");
  });
  it("drops students, press and the self-employed as not_a_company", () => {
    const out = run("Company,Name,Title,Email\nSelf-employed,A One,Consultant,a@gmail.com\nPress,B Two,Reporter,b@gmail.com\nUniversity of Kessenbrook,C Three,PhD Candidate,c@kessen.example\nFreelance,D Four,Founder,d@icloud.com\n");
    expect(out.contacts.map((c) => c.drop_reason)).toEqual(["not_a_company", "not_a_company", "not_a_company", "not_a_company"]);
    expect(out.companies).toEqual([]);
  });
  it("does not drop a real company whose name holds one of those words", () => {
    for (const [company, title] of [["Press Ganey", "Account Executive"], ["Independent Bank", "VP Sales"], ["Student Loan Servicing Co", "Director"], ["University Games", "Marketing Manager"], ["Radio Flyer", "Sales Director"], ["Weekly Standard Media", "Sales Director"], ["Home Depot", "Manager"]]) {
      const c = cleanRow(row({ company, title, email: "a@acme.example" }));
      expect(c.not_a_company, company).toBe(false);
    }
  });
});

describe("fields in the wrong column", () => {
  it("moves a company and a title that sit in each other's columns", () => {
    const c = cleanRow(row({ company: "Senior Channel Manager", title: "Jade & Saum Home", email: "a@x.example" }));
    expect(c).toMatchObject({ company: "Jade & Saum Home", title: "Senior Channel Manager" });
    expect(c.issues).toContain("swapped_company_title");
  });
  it("does not read a company as a title unless every word is a title word", () => {
    for (const name of ["Partners Group", "Head Hunters Inc", "Lead Generation Partners", "Manager Media", "Strategic Advisors", "Product Hunt", "Sales Force Staffing"]) expect(looksLikeTitle(name), name).toBe(false);
    expect(looksLikeTitle("Head of Revenue Operations")).toBe(true);
    expect(looksLikeTitle("Gerente de Ventas")).toBe(true);
  });
  it("leaves both alone and flags it when the title also reads as a title", () => {
    const c = cleanRow(row({ company: "Account Executive", title: "Account Executive", email: "a@x.example" }));
    expect(c.company).toBe("Account Executive");
    expect(c.issues).toContain("company_looks_like_title");
  });
  it("moves an email that sits in the company column", () => {
    const c = cleanRow(row({ company: "ann@acme.example", full: "Ann Lee" }));
    expect(c.email).toBe("ann@acme.example");
    expect(c.company).toBe("");
  });
  it("swaps first and last name only when the badge name proves the order, otherwise flags", () => {
    expect(cleanRow(row({ company: "Beld", first: "Furtado", last: "Fernanda", badge: "Fernanda", email: "fernanda_furtado@beldu.example" }))).toMatchObject({ first: "Fernanda", last: "Furtado" });
    const c = cleanRow(row({ company: "Beld", first: "Furtado", last: "Fernanda", email: "fernanda_furtado@beldu.example" }));
    expect(c).toMatchObject({ first: "Furtado", last: "Fernanda" });
    expect(c.issues).toContain("name_order_suspect");
    expect(cleanRow(row({ company: "Beld", first: "Fernanda", last: "Furtado", badge: "Fernanda", email: "fernanda_furtado@beldu.example" })).issues).toEqual([]);
  });
});

describe("a row needs any one of company, email or LinkedIn", () => {
  it("accepts a file with no company column when it has an email or LinkedIn column", () => {
    const a = run("Name,Work Email\nAnn Lee,ann@acme.example\n");
    expect(a.contacts[0].drop_reason).toBeNull();
    const b = run("Name,LinkedIn URL\nAnn Lee,https://www.linkedin.com/in/ann-lee\n");
    expect(b.contacts[0].linkedin).toBe("https://www.linkedin.com/in/ann-lee");
    expect(b.contacts[0].drop_reason).toBeNull();
  });
  it("keeps a row with only a LinkedIn URL, drops one with only a name as junk_row", () => {
    const out = run("Company,Name,Email,LinkedIn\n,Ann Lee,,https://www.linkedin.com/in/ann-lee\n,Bo Ray,,\n-,-,-,-\n");
    expect(out.contacts.map((c) => c.drop_reason)).toEqual([null, "junk_row"]);
    expect(out.sourceRows.map((r) => r.drop_reason)).toEqual([null, "junk_row", "junk_row"]);
  });
});

describe("the list quality report", () => {
  it("counts rows by issue and says how bad the list is, with sample rows", () => {
    const out = run("Company,Name,Email\nAcme,Ann Lee,ann@test.com\nAcme,Bo Ray,bo@test.com\nN/A,Cy Day,cy@gmail.com\nZed,Di Fay,di@zed.example\n");
    expect(out.quality.issues.placeholder_email).toBe(2);
    expect(out.quality.samples.placeholder_email).toEqual([1, 2]);
    expect(out.quality.clean_rows).toBe(1);
    expect(out.quality.verdict).toBe("poor");
    expect(out.quality.summary[0]).toMatch(/2 rows with placeholder/);
  });
});
