/* What the person actually typed. Quoted threads, signatures and sending-tool footers are removed before any code or model reads a reply, so the word "unsubscribe" in a footer can never opt out someone who said yes. */

const REPLY_HEADER = [
  /^\s*On .{5,200} wrote:\s*$/i, /^\s*El .{5,200} escribi[oó]:\s*$/i, /^\s*Am .{5,200} schrieb .{0,80}:\s*$/i, /^\s*Le .{5,200} a [eé]crit\s*:\s*$/i, /^\s*Em .{5,200} escreveu:\s*$/i,
  /^\s*-{2,}\s*(Original Message|Forwarded message|Mensaje original|Mensagem original|Urspr[uü]ngliche Nachricht)\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/, /^\s*(From|De|Von|Sent|Enviado|Gesendet)\s*:\s.+$/i,
];
const SIGNATURE = [/^\s*--\s*$/, /^\s*(Sent from my|Sent via|Enviado desde mi|Von meinem .* gesendet|Get Outlook for)\b/i];
/** A line a sending tool or legal template adds. Only a line carrying a link, or the template wording, counts: a person writing "please unsubscribe me from this email list" is a request, not a footer. */
const FOOTER = [/\b(unsubscribe|opt[ -]?out|darse de baja|abmelden|d[eé]sabonner|preferences)\b.*https?:\/\//i, /https?:\/\/\S*\b(unsubscribe|opt[ -]?out|preferences)\b/i, /^\s*(if you (no longer wish|would (prefer|rather) not|do not wish) to receive)/i, /^\s*(to unsubscribe|click here to unsubscribe|manage (your )?(email )?preferences)\b/i];

/** The text the person wrote, or an empty string when nothing is left. */
export function cleanReply(body: string | null | undefined): string {
  const kept: string[] = [];
  for (const line of (body ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (REPLY_HEADER.some((r) => r.test(line)) || SIGNATURE.some((r) => r.test(line))) break;
    if (/^\s*>/.test(line) || FOOTER.some((r) => r.test(line))) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
