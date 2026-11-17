/* Third-party tools by their plain job. In the sample desk no real Apollo, Instantly or Slack is connected, so a bare vendor name reads as if it were live.
   There the screen says what the tool does and marks it as a sample. A real desk keeps the vendor's name. Set once by the app, like the demo calendar. */

let sample = false;
export const setSampleTools = (on: boolean) => { sample = on; };

const JOB: Record<string, string> = {
  apollo: "people finder", zerobounce: "email checker", instantly: "email tool", smartlead: "email tool", heyreach: "LinkedIn tool", gong: "call recorder", slack: "chat tool",
};
const NAMES = /\b(Apollo|ZeroBounce|Instantly|Smartlead|HeyReach|Gong|Slack)\b/g;

/** One tool by its key or name: "Instantly" in a real desk, "email tool (sample)" in the sample one. */
export function toolName(key: string, fallback = "the tool"): string {
  const k = key.toLowerCase();
  const real = ({ apollo: "Apollo", zerobounce: "ZeroBounce", instantly: "Instantly", smartlead: "Smartlead", heyreach: "HeyReach", gong: "Gong", slack: "Slack" } as Record<string, string>)[k];
  if (!real) return fallback;
  return sample ? `${JOB[k]} (sample)` : real;
}

/** A sentence with every tool name in it swapped the same way, for the activity log and the pause reasons the server wrote. */
export const plainTools = (text: string): string => (sample ? text.replace(NAMES, (m) => `${JOB[m.toLowerCase()]} (sample)`) : text);
