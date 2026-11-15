/* Service worker. Does every fetch to the desk, with Authorization: Bearer.
   Injects the reader into the active tab only when the popup asks, after a
   button press. Keeps a small run status so the popup can show counts. */

const NOT_DIR = 'This page is not a directory the extension can read yet. Use a screen recording on the event.';
const CHANGED = "The page looks like Swapcard's directory but its layout has changed: nothing was read. Tell the desk's admin.";
const INJECT_FILES = ['readers/swapcard.js', 'readers/index.js', 'scroll.js', 'inject.js'];

const blank = () => ({ running: false, tabId: null, eventId: null, read: 0, added: 0, alreadyIn: 0, toCheck: 0, message: '', done: false });
let state = blank();

async function loadSettings() {
  const s = await chrome.storage.local.get(['deskUrl', 'captureKey', 'eventId']);
  return { deskUrl: s.deskUrl || '', captureKey: s.captureKey || '', eventId: s.eventId || '' };
}

async function saveState() {
  try { await chrome.storage.session.set({ runState: state }); } catch (e) { /* session storage can be missing; counts then live in memory only */ }
}

async function currentState() {
  if (!state.running && !state.done && !state.message) {
    try {
      const s = await chrome.storage.session.get('runState');
      if (s.runState) state = s.runState;
    } catch (e) { /* ignore */ }
  }
  return state;
}

function sentenceFor(status, body) {
  if (body && typeof body.error === 'string' && body.error) return body.error;
  if (body && typeof body.message === 'string' && body.message) return body.message;
  if (status === 401) return 'The desk did not accept this key. Make a new one in the desk settings.';
  if (status === 409) return 'This event cannot take a list now. Pick another event.';
  if (status === 429) return 'Too many people sent too fast. Wait a minute and try again.';
  if (status === 400) return 'The desk did not accept this page.';
  return 'The desk could not be reached. Check its address.';
}

async function deskFetch(path, init) {
  const { deskUrl, captureKey } = await loadSettings();
  if (!deskUrl || !captureKey) return { ok: false, status: 0, error: 'Set the desk address and key first.' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(deskUrl.replace(/\/+$/, '') + path, {
      ...init,
      signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + captureKey, 'Content-Type': 'application/json' },
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) return { ok: false, status: res.status, error: sentenceFor(res.status, body) };
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: sentenceFor(0, null) };
  } finally {
    clearTimeout(timer);
  }
}

async function listEvents() {
  const r = await deskFetch('/api/capture/events', { method: 'GET' });
  if (!r.ok) return r;
  const events = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.events) ? r.body.events : []);
  return { ok: true, events };
}

async function startRun({ tabId, mode, eventId }) {
  if (!eventId) return { ok: false, error: 'Pick an event first.' };
  state = { ...blank(), running: true, tabId, eventId };
  await saveState();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (m) => globalThis.EDRun.start({ mode: m }),
      args: [mode === 'scroll' ? 'scroll' : 'once'],
    });
  } catch (e) {
    state = { ...blank(), done: true, message: NOT_DIR };
    await saveState();
    return { ok: false, error: NOT_DIR };
  }
  return { ok: true };
}

async function stopRun() {
  const tabId = state.tabId;
  if (tabId != null) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (globalThis.EDRun) globalThis.EDRun.stop(); } });
    } catch (e) { /* the tab may be gone or no longer allowed; the page stops itself when hidden */ }
  }
  if (state.running) state = { ...state, running: false, done: true, message: state.message || 'Stopped.' };
  await saveState();
  return { ok: true };
}

async function onBatch(msg) {
  if (!state.running) return { ok: false };
  const { eventId } = state;
  const r = await deskFetch('/api/capture/people', {
    method: 'POST',
    body: JSON.stringify({ event_id: eventId, platform: msg.platform, page_url: msg.pageUrl, people: msg.people }),
  });
  if (!r.ok) {
    state = { ...state, running: false, done: true, message: r.error };
    await saveState();
    return { ok: false, error: r.error };
  }
  const b = r.body || {};
  state = {
    ...state,
    read: msg.read,
    added: state.added + (b.added || 0),
    alreadyIn: state.alreadyIn + (b.already_in || 0),
    toCheck: state.toCheck + (b.to_check || 0),
  };
  await saveState();
  return { ok: true };
}

async function onDone(msg) {
  let text = state.message;
  if (msg.reason === 'not_a_directory') text = NOT_DIR;
  else if (msg.reason === 'layout_changed') text = CHANGED;
  else if (msg.reason === 'send_failed') text = state.message || sentenceFor(0, null);
  else if (msg.reason === 'bottom') text = 'Reached the bottom of the list.';
  else if (msg.reason === 'idle') text = 'Nothing new after 3 steps. Done.';
  else if (msg.reason === 'limit') text = 'Stopped at 1,500 people.';
  else if (msg.reason === 'read_once') text = state.read ? 'Read what is on the page.' : 'No people were on the page.';
  else if (msg.reason === 'stopped') text = state.message || 'Stopped.';
  state = { ...state, running: false, done: true, read: Math.max(state.read, msg.read || 0), message: text };
  await saveState();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const isPage = sender && sender.tab;
  let job;
  switch (msg && msg.type) {
    case 'events': job = listEvents(); break;
    case 'start': job = startRun(msg); break;
    case 'stop': job = stopRun(); break;
    case 'status': job = currentState().then((s) => ({ ok: true, state: s })); break;
    case 'ed:batch': job = isPage && sender.tab.id === state.tabId ? onBatch(msg) : Promise.resolve({ ok: false }); break;
    case 'ed:done': job = isPage && sender.tab.id === state.tabId ? onDone(msg) : Promise.resolve({ ok: false }); break;
    default: return false;
  }
  job.then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
