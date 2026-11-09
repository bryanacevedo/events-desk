/* Who can do what, in one place. Acting as is a stand-in for a real login: the desk takes the
   name it is given. Seat approvers come from config/defaults.json. */

export interface Persona { name: string; role: string }

export const PERSONAS: Persona[] = [
  { name: "Maya Ortiz", role: "SDR" },
  { name: "Dan Whitlock", role: "Approves seats" },
  { name: "GTM Team", role: "GTM Engineering" },
];

/** The only people who can open Settings or change it. */
export const GTM_TEAM = ["GTM Team"];
export const isGtm = (actor: string) => GTM_TEAM.includes(actor);
export const SETTINGS_REFUSAL = "Settings are managed by GTM Engineering. Contact them.";
