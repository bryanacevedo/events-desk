/* The gate's reasons, in words a person reads on a card or a screen. */

const WORDS: Record<string, string> = {
  opted_out: "opted out", wrong_person: "wrong person", owner_pending: "waiting on the account owner", owner_mine: "kept by the account owner",
  no_email: "no email", not_verified_enough: "email not verified", verification_stale: "email checked too long ago", crm_bounced: "bounced in the CRM",
  no_linkedin: "no LinkedIn", name_unknown: "name unknown", no_domain: "no company domain", no_legal_basis: "no contact basis for their region",
  in_another_cadence: "in another sequence", cool_off: "said no recently", reply_waiting: "reply waiting on a person", met_in_person: "met in person",
  account_do_not_prospect: "account marked do not prospect", crm_recent_activity: "recent CRM activity", desk_stopped: "all sending stopped", not_found: "not found",
};

/** One reason in words. Families like `hold:meeting` and `dropped:low_tier` read by their family. */
export function gateWords(reason: string): string {
  if (WORDS[reason]) return WORDS[reason];
  if (reason.startsWith("hold:")) return reason === "hold:meeting" ? "a meeting at their company" : "their company is on hold";
  if (reason.startsWith("dropped:")) return "dropped from the list";
  if (reason.startsWith("gate:")) return gateWords(reason.slice(5));
  return reason.replace(/_/g, " ");
}
