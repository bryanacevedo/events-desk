/* The "I'm going" kit (docs/SPEAKING.md 8): a side sheet with the person's photo choice, the six images as a contact sheet in proportion with the caption under them,
   the wording, and the link to paste back after posting. The desk draws the images when the sheet opens and keeps none. It never posts: the person does. */

import { useEffect, useRef, useState } from "react";
import { get, send, fetchBlob, type KitOffer, type KitSheetData } from "./api";
import { useActor } from "./App";
import { copyText, HSheet } from "./Guests";
import { Editable, Form } from "./PlanEdit";
import { dm } from "./words";

export const ROLE_WORDS: Record<string, string> = { attending: "Going", speaking: "Speaking", sponsoring: "Sponsoring", hosting: "Hosting" };
const PHOTO_WORDS: Record<string, string> = { upload: "Uploaded photo", slack: "Slack photo" };
const SIZES: Record<string, string> = { post_landscape: "Post, landscape", post_portrait: "Post, 4:5", square: "Square", story: "Story", banner: "Banner", signature: "Email signature" };
/** Rows of the contact sheet: the four tall shapes share a height, the two wide ones each take a row. */
const ROWS = [["post_landscape", "post_portrait", "square", "story"], ["banner", "signature"]];

/** One image of the kit: fetched with the acting person's name, shown at its own proportion. `rev` redraws it after the photo or the organizer's kit changes. */
function KitImage({ url, w, h, label, rev }: { url: string; w: number; h: number; label: string; rev: number }) {
  const { actor } = useActor();
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true, made = "";
    fetchBlob(url, actor).then((b) => { if (live && b) { made = URL.createObjectURL(b); setSrc(made); } });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [url, actor, rev]);
  return <span className="ks-img" style={{ aspectRatio: `${w} / ${h}` }}>{src && <img src={src} alt={`${label}, ${w} by ${h}`} width={w} height={h} />}</span>;
}

async function download(url: string, name: string, actor: string) {
  const b = await fetchBlob(`${url}?download=1`, actor);
  if (!b) return false;
  const href = URL.createObjectURL(b), a = document.createElement("a");
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 5000);
  return true;
}

const toBase64 = (buf: ArrayBuffer) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

/** The organizer's own assets, for planners: a colour, one hashtag and a PNG logo. They are given to the team; the desk does not find them. */
function OrganizerKit({ eventId, done, saved, have }: { eventId: string; done: () => void; saved: () => Promise<void>; have?: { color: string | null; hashtag: string } | null }) {
  const { actor } = useActor();
  const [color, setColor] = useState(have?.color ?? "#1F5D3F"), [tag, setTag] = useState(have?.hashtag ?? ""), [logo, setLogo] = useState<File | null>(null), [clear, setClear] = useState(false);
  return (
    <Form saveWord="Save the organizer's kit" onCancel={done} ready={tag.trim() !== "" || logo !== null || clear} onSave={async () => {
      const body: Record<string, unknown> = { color, hashtag: tag };
      if (logo) body.logo_base64 = toBase64(await logo.arrayBuffer());
      if (clear) body.clear_logo = true;
      const r = await send("PUT", `/api/events/${eventId}/organizer-kit`, actor, body);
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <div className="pl-edit-grid">
        <label className="field"><span>Main colour</span><input className="input ks-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
        <label className="field"><span>Hashtag</span><input className="input" value={tag} maxLength={60} placeholder="#Money2020" onChange={(e) => setTag(e.target.value)} autoComplete="off" /></label>
        <label className="field"><span>Logo, PNG up to 500 KB</span><input className="input" type="file" accept="image/png" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} /><span>Remove the saved logo</span></label>
    </Form>
  );
}

export function KitSheet({ offerId, eventName, planner, close, changed }: { offerId: string; eventName: string; planner: boolean; close: () => void; changed: () => void }) {
  const { actor } = useActor();
  const [k, setK] = useState<KitSheetData | null>(null), [rev, setRev] = useState(0), [gone, setGone] = useState(false);
  const [idx, setIdx] = useState(0), [text, setText] = useState(""), [copied, setCopied] = useState(false), [link, setLink] = useState("");
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [note, setNote] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const load = async (first = false) => {
    const x = await get<KitSheetData>(`/api/kit/${offerId}`);
    if (!x) { setGone(true); return; }
    setK(x);
    if (first) { setIdx(x.caption_index); setText(x.captions[x.caption_index] ?? ""); }
  };
  useEffect(() => { void load(true); }, [offerId, actor]);

  const title = k ? `${k.role_line} ${eventName}` : eventName;
  if (gone) return <HSheet label={eventName} close={close}><p className="mute">This kit could not be opened.</p></HSheet>;
  if (!k) return <HSheet label={title} close={close}>{null}</HSheet>;

  const run = async (key: string, fn: () => ReturnType<typeof send>, after?: (d: unknown) => void) => {
    setBusy(key); setError(""); setNote("");
    const r = await fn();
    setBusy("");
    if (!r.ok) { setError(r.error); return; }
    after?.(r.data);
    await load(); setRev((n) => n + 1);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    const bytes = await f.arrayBuffer();
    await run("photo", () => send("PUT", "/api/kit/photo", actor, undefined, { bytes, filename: f.name, type: f.type || "image/png" }));
    if (file.current) file.current.value = "";
  };
  const wording = (i: number) => { setIdx(i); setText(k.captions[i] ?? ""); setCopied(false); if (k.own) void send("PATCH", `/api/kit/${offerId}`, actor, { caption: i }); };
  const copy = async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } };
  const all = async () => { setBusy("all"); for (const im of k.images) { await download(im.url, `${eventName.replace(/\W+/g, "-")}-${im.id}.png`, actor); await new Promise((r) => setTimeout(r, 450)); } setBusy(""); };
  const byId = Object.fromEntries(k.images.map((i) => [i.id, i]));

  return (
    <HSheet label={title} close={close}>
      {k.own && (
        <section className="sheet-sec" aria-label="Photo"><h3>Photo</h3>
          <div className="ks-photo">
            <span className={k.photo ? "" : "mute"}>{k.photo ? PHOTO_WORDS[k.photo] : "No photo, initials"}</span>
            <span className="as-end">
              <button type="button" className="btn line small" disabled={busy !== ""} onClick={() => file.current?.click()}>Upload a photo</button>
              {k.slack_available && <button type="button" className="btn line small" disabled={busy !== ""} onClick={() => run("slack", () => send<{ custom: boolean }>("POST", "/api/kit/photo/slack", actor), (d) => { if ((d as { custom?: boolean }).custom === false) setNote("This looks like Slack's default picture"); })}>Use my Slack photo</button>}
              {k.photo && <button type="button" className="btn line small" disabled={busy !== ""} onClick={() => run("remove", () => send("DELETE", "/api/kit/photo", actor))}>Remove</button>}
            </span>
            <input ref={file} className="sr-only" type="file" accept="image/png,image/jpeg" tabIndex={-1} aria-label="Photo file" onChange={(e) => void upload(e.target.files?.[0])} />
          </div>
        </section>
      )}

      <section className="sheet-sec" aria-label="Images"><h3>Images<span>6 PNG files</span></h3>
        <div className="ks-sheet">
          {ROWS.map((row, i) => (
            <div className={`ks-row${i === 1 ? " wide" : ""}`} key={i}>
              {row.map((id) => {
                const im = byId[id];
                if (!im) return null;
                return (
                  <figure className="ks-cell" key={id} style={{ "--r": im.w / im.h } as React.CSSProperties}>
                    <KitImage url={im.url} w={im.w} h={im.h} label={SIZES[id] ?? im.label} rev={rev} />
                    <figcaption><b>{SIZES[id] ?? im.label}</b><span className="mute">{im.w} × {im.h}</span>
                      <button type="button" className="btn line small" disabled={busy === "all"} onClick={() => download(im.url, `${eventName.replace(/\W+/g, "-")}-${id}.png`, actor)} aria-label={`Download ${SIZES[id] ?? im.label}`}>Download</button>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          ))}
        </div>
        <div className="actions"><button type="button" className="btn small" disabled={busy !== ""} onClick={all}>{busy === "all" ? "Downloading" : "Download all"}</button></div>
      </section>

      <section className="sheet-sec" aria-label="Caption"><h3>Caption</h3>
        <div className="ks-words">
          <div className="seg" role="group" aria-label="Wording">{k.captions.map((_, i) => <button type="button" key={i} aria-pressed={idx === i} onClick={() => wording(i)}>Wording {i + 1}</button>)}</div>
          <textarea className="input itext" rows={5} aria-label="Caption" value={text} onChange={(e) => { setText(e.target.value); setCopied(false); }} />
          <div className="actions"><button type="button" className="btn line small" onClick={copy}>{copied ? "Copied" : "Copy the caption"}</button></div>
        </div>
      </section>

      <section className="sheet-sec" aria-label="After you post"><h3>After you post</h3>
        <p className="ks-never">You post this yourself. Events Desk never posts for you.</p>
        {k.post_url && <p className="ks-posted">Posted. <a href={k.post_url} target="_blank" rel="noreferrer">{new URL(k.post_url).pathname.replace(/\/$/, "").slice(0, 48) || k.post_url}</a></p>}
        {k.own && (
          <div className="ks-link">
            <label className="field"><span>Link to your post</span><input className="input" type="url" inputMode="url" placeholder="https://www.linkedin.com/" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" /></label>
            <button type="button" className="btn line small" disabled={busy !== "" || !link.trim()} onClick={() => run("link", () => send("PATCH", `/api/kit/${offerId}`, actor, { post_url: link }), () => { setLink(""); changed(); })}>Save the link</button>
          </div>
        )}
        {error && <p role="alert" className="error small">{error}</p>}
        {note && <p className="mute">{note}</p>}
      </section>

      {planner && (
        <section className="sheet-sec" aria-label="Organizer's kit"><h3>Organizer&apos;s kit</h3>
          <Editable can label="Set the organizer's kit" view={null} editor={(done) => <OrganizerKit have={k.organizer_kit} eventId={k.event_id} done={done} saved={async () => { await load(); setRev((n) => n + 1); }} />} />
        </section>
      )}

      {k.own && <div className="actions"><button type="button" className="btn line small" disabled={busy !== ""} onClick={() => run("dismiss", () => send("PATCH", `/api/kit/${offerId}`, actor, { dismiss: true }), () => { changed(); close(); })}>Dismiss this kit</button></div>}
    </HSheet>
  );
}

/** The person's kits on My day: one row each, a button that opens the sheet. */
export function KitRows({ offers, open }: { offers: KitOffer[]; open: (o: KitOffer) => void }) {
  return (
    <ul className="pl-rows" aria-label="Your kits">
      {offers.map((o) => (
        <li className="pl-row" key={o.id}>
          <span className="pl-what"><b>{o.event_name}</b><span>{ROLE_WORDS[o.role] ?? o.role}</span></span>
          <span className="pl-mid">{o.post_url ? `Posted ${o.posted_at ? dm(o.posted_at.slice(0, 10)) : ""}` : ""}</span>
          <span className="pl-end"><button type="button" className="btn line small" data-row={`kit-${o.id}`} onClick={() => open(o)} aria-label={`Open the kit for ${o.event_name}`}>Kit</button></span>
        </li>
      ))}
    </ul>
  );
}
