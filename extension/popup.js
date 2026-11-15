const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let settings = { deskUrl: '', captureKey: '', eventId: '' };
let timer = null;

function show(view) {
  for (const id of ['setup', 'setup-foot', 'work', 'work-foot']) $(id).hidden = true;
  if (view === 'setup') { $('setup').hidden = false; $('setup-foot').hidden = false; $('settings-btn').hidden = !(settings.deskUrl && settings.captureKey); }
  else { $('work').hidden = false; $('work-foot').hidden = false; $('settings-btn').hidden = false; }
}

function normalizeAddress(text) {
  let u;
  try { u = new URL(text.trim()); } catch (e) { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
}

async function save() {
  const origin = normalizeAddress($('desk-url').value);
  const key = $('capture-key').value.trim();
  const msg = $('setup-msg');
  if (!origin) { msg.textContent = 'Type the desk address as it appears in your browser, starting with https://.'; return; }
  if (!key) { msg.textContent = 'Paste the capture key from the desk settings.'; return; }
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [origin + '/*'] }); } catch (e) { granted = false; }
  await chrome.storage.local.set({ deskUrl: origin, captureKey: key });
  settings.deskUrl = origin; settings.captureKey = key;
  if (!granted) msg.textContent = 'Without access to that address the extension cannot reach the desk. Press Save again and choose Allow when the browser asks, or turn on access to the site on the extension details page.';
  else msg.textContent = '';
  await openWork();
}

async function openWork() {
  show('work');
  $('work-msg').textContent = 'Loading events...';
  const r = await send({ type: 'events' });
  const box = $('events');
  box.textContent = '';
  if (!r || !r.ok) { $('work-msg').textContent = (r && r.error) || 'The desk could not be reached. Check its address.'; return; }
  if (!r.events.length) { $('work-msg').textContent = 'No event can take a list right now.'; return; }
  $('work-msg').textContent = '';
  for (const ev of r.events) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'event'; input.value = ev.id;
    input.checked = ev.id === settings.eventId;
    input.addEventListener('change', () => { settings.eventId = ev.id; chrome.storage.local.set({ eventId: ev.id }); });
    const mid = document.createElement('span');
    const b = document.createElement('b'); b.textContent = ev.name;
    const sub = document.createElement('span');
    sub.textContent = [ev.starts_on, ev.venue].filter(Boolean).join(' / ');
    mid.append(b, sub);
    const em = document.createElement('em');
    em.textContent = (ev.reads || 0) + ' read';
    label.append(input, mid, em);
    box.append(label);
  }
  if (!settings.eventId && r.events.length === 1) {
    settings.eventId = r.events[0].id;
    box.querySelector('input').checked = true;
    chrome.storage.local.set({ eventId: settings.eventId });
  }
  refresh();
}

async function begin(mode) {
  if (!settings.eventId) { $('work-msg').textContent = 'Pick an event first.'; return; }
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) { tab = null; }
  if (!tab || tab.id == null) { $('work-msg').textContent = 'Open the directory page in this window, then try again.'; return; }
  $('work-msg').textContent = '';
  const r = await send({ type: 'start', tabId: tab.id, mode, eventId: settings.eventId });
  if (!r || !r.ok) $('work-msg').textContent = (r && r.error) || 'Could not start.';
  refresh();
}

async function refresh() {
  const r = await send({ type: 'status' });
  const s = r && r.state;
  if (!s) return;
  const busy = !!s.running;
  $('read-btn').disabled = busy; $('scroll-btn').disabled = busy;
  $('stop-btn').hidden = !busy;
  const counts = $('counts');
  if (busy || s.done) { counts.hidden = false; counts.textContent = s.read + ' read, ' + s.added + ' new'; } else counts.hidden = true;
  if (s.message) $('work-msg').textContent = s.message;
  clearTimeout(timer);
  if (busy) timer = setTimeout(refresh, 600);
}

$('save-btn').addEventListener('click', save);
$('settings-btn').addEventListener('click', () => {
  $('desk-url').value = settings.deskUrl; $('capture-key').value = ''; $('setup-msg').textContent = '';
  show('setup');
});
$('read-btn').addEventListener('click', () => begin('once'));
$('scroll-btn').addEventListener('click', () => begin('scroll'));
$('stop-btn').addEventListener('click', async () => { await send({ type: 'stop' }); refresh(); });

(async function init() {
  settings = await chrome.storage.local.get(['deskUrl', 'captureKey', 'eventId']);
  settings = { deskUrl: settings.deskUrl || '', captureKey: settings.captureKey || '', eventId: settings.eventId || '' };
  if (settings.deskUrl && settings.captureKey) await openWork(); else show('setup');
})();
