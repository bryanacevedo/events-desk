/* The simulated reader for calls for papers (the demo and the tests). It finds each sentence that gives a closing day, takes the nearest address after it, and quotes the sentence. Deterministic; not a model. */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function simulatedCalls(prompt: string): string {
  const start = prompt.indexOf("<<<PAGE"), end = prompt.lastIndexOf("PAGE>>>");
  const page = start >= 0 ? prompt.slice(start + 7, end >= 0 ? end : undefined) : prompt;
  const calls: { title: string; closes_on: string; link: string; quote: string }[] = [];
  for (const line of page.split(/\n+/)) {
    const m = /(?:clos(?:es|ing)|deadline)[^.\n]{0,40}?(\d{1,2}) (january|february|march|april|may|june|july|august|september|october|november|december),? (\d{4})/i.exec(line);
    if (!m) continue;
    const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    const day = `${m[3]}-${String(month).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
    const link = /https?:\/\/[^\s)"']+/.exec(line)?.[0] ?? /https?:\/\/[^\s)"']+/.exec(page)?.[0] ?? "";
    const quote = line.slice(Math.max(0, m.index - 30), m.index + m[0].length).trim();
    calls.push({ title: /call for (content|papers|speakers|proposals)/i.exec(line)?.[0] ?? "Call for content", closes_on: day, link, quote });
  }
  return JSON.stringify({ calls });
}
