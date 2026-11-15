// Redesign step 4 (docs/DIRECTORY.md sections 6 and 11): the extension's Swapcard reader on every
// fixture in headless Chrome, the scroll controller's stopping rules, the manifest's permission
// list, the readers' source, and the unpacked extension loaded once in Chrome.
// The fixtures are reconstructions of Swapcard's web app pattern, not captures.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = resolve(__dirname, '..');
const EXT = join(ROOT, 'extension');
const FIX = join(EXT, 'fixtures');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HAVE_CHROME = existsSync(CHROME);
const SKIP_WHY = `no Chrome at ${CHROME}; set CHROME to a Chrome binary to run the browser tests`;
const READER_FILES = ['readers/swapcard.js', 'readers/index.js'].map((f) => join(EXT, f));
const PEOPLE_URL = 'https://app.swapcard.com/event/aws-demo-summit/people';

function load(file: string, sandbox: Record<string, unknown> = {}) {
  const ctx: Record<string, any> = { ...sandbox };
  ctx.globalThis = ctx;
  vm.runInNewContext(readFileSync(file, 'utf8'), ctx);
  return ctx;
}

// ------------------------------------------------------------------ pure tests

describe('scroll controller (pure)', () => {
  const { EDScroll } = load(join(EXT, 'scroll.js'));
  const make = (o: Record<string, unknown> = {}) => EDScroll.create(o);

  it('steps 70 percent of the window height', () => {
    expect(make().stepSize(1000)).toBe(700);
    expect(make().stepSize(813)).toBe(569);
  });

  it('delay is 800 to 1800 ms from the injected random', () => {
    expect(make({ random: () => 0 }).nextDelay()).toBe(800);
    expect(make({ random: () => 1 }).nextDelay()).toBe(1800);
    expect(make({ random: () => 0.5 }).nextDelay()).toBe(1300);
  });

  it('uses the injected clock to say when the next step is due', () => {
    let t = 1000;
    const c = make({ random: () => 0, now: () => t });
    expect(c.scheduleNext()).toEqual({ delay: 800, dueAt: 1800 });
    expect(c.isDue()).toBe(false);
    t = 1799; expect(c.isDue()).toBe(false);
    t = 1800; expect(c.isDue()).toBe(true);
  });

  it('stops after 3 steps with nothing new, and a new person resets the count', () => {
    const c = make();
    expect(c.record({ newPeople: 0, total: 10, atBottom: false }).stop).toBe(false);
    expect(c.record({ newPeople: 0, total: 10, atBottom: false }).stop).toBe(false);
    expect(c.record({ newPeople: 3, total: 13, atBottom: false }).stop).toBe(false);
    expect(c.record({ newPeople: 0, total: 13, atBottom: false }).stop).toBe(false);
    expect(c.record({ newPeople: 0, total: 13, atBottom: false }).stop).toBe(false);
    expect(c.record({ newPeople: 0, total: 13, atBottom: false })).toEqual({ stop: true, reason: 'idle' });
  });

  it('stops at the bottom, at 1500 people, and on stop', () => {
    expect(make().record({ newPeople: 5, total: 40, atBottom: true })).toEqual({ stop: true, reason: 'bottom' });
    expect(make().record({ newPeople: 5, total: 1500, atBottom: false })).toEqual({ stop: true, reason: 'limit' });
    expect(make().record({ newPeople: 5, total: 1499, atBottom: false }).stop).toBe(false);
    const c = make(); c.stop();
    expect(c.record({ newPeople: 5, total: 5, atBottom: false })).toEqual({ stop: true, reason: 'stopped' });
  });

  it('the loop scrolls by 70 percent, waits the injected delay and ends on each rule', async () => {
    const run = async (opts: { people: number[]; bottomAt?: number; stopAfter?: number }) => {
      const c = make({ random: () => 0 });
      const sleeps: number[] = []; const scrolls: number[] = [];
      let step = 0; let total = opts.people[0] ?? 0;
      const out = await c.run({
        height: () => 1000,
        atBottom: () => step === opts.bottomAt,
        scrollStep: (px: number) => { scrolls.push(px); },
        sleep: async (ms: number) => { sleeps.push(ms); },
        readNew: async () => {
          step += 1;
          const n = opts.people[step] ?? 0; total += n;
          if (opts.stopAfter === step) c.stop();
          return { newPeople: n, total };
        },
      }, total);
      return { out, sleeps, scrolls };
    };
    const idle = await run({ people: [5, 0, 0, 0, 9] });
    expect(idle.out.reason).toBe('idle');
    expect(idle.scrolls).toEqual([700, 700, 700]);
    expect(idle.sleeps).toEqual([800, 800, 800]);
    expect((await run({ people: [5, 4, 4, 4, 4, 4], bottomAt: 3 })).out.reason).toBe('bottom');
    expect((await run({ people: [5, 4, 4, 4, 4, 4], stopAfter: 2 })).out.reason).toBe('stopped');
    expect((await run({ people: [1400, 150] })).out.reason).toBe('limit');
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
  it('is MV3 with exactly activeTab, scripting and storage', () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'scripting', 'storage']);
  });
  it('has no content_scripts key, no declared host access, and only optional host patterns', () => {
    expect('content_scripts' in manifest).toBe(false);
    expect('host_permissions' in manifest).toBe(false);
    expect(manifest.optional_host_permissions.length).toBeGreaterThan(0);
    for (const p of manifest.optional_host_permissions) expect(p).toMatch(/^(https:\/\/\*|http:\/\/(localhost|127\.0\.0\.1))\/\*$/);
    expect('optional_permissions' in manifest).toBe(false);
  });
  it('fails on a forbidden permission (checker self-test)', () => {
    const allowed = new Set(['activeTab', 'scripting', 'storage']);
    for (const bad of ['cookies', 'tabs', 'history', 'webRequest']) expect([bad].every((p) => allowed.has(p))).toBe(false);
  });
  it('declares nothing that would run on its own', () => {
    expect(JSON.stringify(manifest)).not.toMatch(/content_scripts|web_accessible|externally_connectable|"alarms"/);
  });
});

describe('reader source', () => {
  const BAD = [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /document\s*\.\s*cookie/, /localStorage/, /sessionStorage/, /indexedDB/, /chrome\s*\./, /cookieStore/, /\.postMessage/];
  const files = [...readdirSync(join(EXT, 'readers')).map((f) => join(EXT, 'readers', f)), join(EXT, 'scroll.js')];
  it('readers and the scroll controller never fetch, send, read cookies or touch storage', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const re of BAD) expect(src, `${f} matched ${re}`).not.toMatch(re);
    }
  });
  it('no source file in the extension uses an em dash', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(EXT)) expect(readFileSync(f, 'utf8'), f).not.toContain('\u2014');
  });
  it('the readers never use class names', () => {
    const src = readFileSync(join(EXT, 'readers/swapcard.js'), 'utf8');
    expect(src).not.toMatch(/className|classList|querySelector(All)?\(\s*['"][^'"]*\./);
  });
  it('every fixture says at its top that it is a reconstruction', () => {
    const names = readdirSync(FIX).filter((f) => f.endsWith('.html'));
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const n of names) expect(readFileSync(join(FIX, n), 'utf8').slice(0, 600), n).toMatch(/RECONSTRUCTION, NOT A CAPTURE/);
    expect(readFileSync(join(EXT, 'README.txt'), 'utf8')).toMatch(/RECONSTRUCTIONS/);
  });
});

// ------------------------------------------------------------ readers in Chrome

type Person = { name: string; title: string; company: string; location: string; profile_url: string };

const d = HAVE_CHROME ? describe : describe.skip;
if (!HAVE_CHROME) console.warn(`directory-readers browser tests skipped: ${SKIP_WHY}`);

d('Swapcard reader on every fixture (headless Chrome)', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  async function open(fixture: string, height = 500) {
    page = await browser.newPage({ viewport: { width: 700, height } });
    // The fixture is served as if it were on Swapcard so `matches` sees a real directory URL.
    await page.route('https://app.swapcard.com/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, fixture), 'utf8') }));
    await page.goto(PEOPLE_URL);
    for (const f of READER_FILES) await page.addScriptTag({ path: f });
    return page;
  }
  const readOnce = (p: Page) => p.evaluate((url) => {
    const r = (globalThis as any).EDReaders.pick(url, document);
    return r ? { id: r.id, ...r.read(document) } : null;
  }, PEOPLE_URL) as Promise<{ id: string; people: Person[]; layout: string } | null>;

  it('two-line cards: name, title, company, location', async () => {
    await open('swapcard-two-line.html');
    const r = (await readOnce(page))!;
    await page.close();
    expect(r.id).toBe('swapcard');
    expect(r.layout).toBe('ok');
    expect(r.people).toHaveLength(8);
    expect(r.people[0]).toMatchObject({ name: 'Priya Raman', title: 'Director of Platform Engineering', company: 'Northwind Logistics', location: 'Singapore' });
    expect(r.people[0].profile_url).toMatch(/^https:\/\/app\.swapcard\.com\/event\/aws-demo-summit\/person\/[A-Za-z0-9+/]+$/);
    expect(new Set(r.people.map((p) => p.profile_url)).size).toBe(8);
    for (const p of r.people) expect(p.name).not.toMatch(/^[A-Z]{1,3}$|Connect/);
  });

  it('one-line cards: "Title at Company" is split', async () => {
    await open('swapcard-one-line.html');
    const r = (await readOnce(page))!;
    await page.close();
    expect(r.layout).toBe('ok');
    expect(r.people).toHaveLength(8);
    expect(r.people[1]).toMatchObject({ name: 'Tomas Lindqvist', title: 'Head of Data', company: 'Fjordline Analytics', location: '' });
    expect(r.people[3]).toMatchObject({ title: 'Senior Solutions Architect', company: 'Cobalt Cloud Partners' });
  });

  it('one line can also split on " @ " and " | "', async () => {
    await open('swapcard-one-line.html');
    const out = await page.evaluate(() => {
      document.body.innerHTML = '<ul><li><div><a href="/event/x/person/AAA"><span>Ada Test</span></a><p>Lead @ Acme Works</p></div></li><li><div><a href="/event/x/person/BBB"><span>Bo Test</span></a><p>Owner | Bo Labs</p></div></li><li><div><a href="/event/x/person/CCC"><span>Cy Test</span></a><p>Consultant</p></div></li></ul>';
      return (globalThis as any).EDReaders.pick(location.href.replace(/^.*$/, 'https://app.swapcard.com/event/x/people'), document).read(document).people;
    });
    await page.close();
    expect(out.map((p: Person) => [p.name, p.title, p.company])).toEqual([['Ada Test', 'Lead', 'Acme Works'], ['Bo Test', 'Owner', 'Bo Labs'], ['Cy Test', 'Consultant', '']]);
  });

  it('virtualized list: few rows in the DOM, and reading as the page scrolls collects all 40', async () => {
    await open('swapcard-virtualized.html');
    const rowsInDom = await page.evaluate(() => document.querySelectorAll('#list li').length);
    expect(rowsInDom).toBeLessThanOrEqual(8);
    const first = (await readOnce(page))!;
    expect(first.layout).toBe('ok');
    expect(first.people.length).toBeGreaterThan(0);
    expect(first.people.length).toBeLessThanOrEqual(8);
    const seen = new Map<string, Person>();
    for (const p of first.people) seen.set(p.profile_url, p);
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.7)));
      await page.waitForTimeout(30);
      for (const p of (await readOnce(page))!.people) seen.set(p.profile_url, p);
    }
    await page.close();
    expect(seen.size).toBe(40);
    expect([...seen.values()].every((p) => p.name.includes(' ') && p.title && p.company)).toBe(true);
  });

  it('layout changed: matches the URL, finds nothing, reports unknown', async () => {
    await open('swapcard-layout-changed.html');
    const r = (await readOnce(page))!;
    await page.close();
    expect(r.id).toBe('swapcard');
    expect(r.people).toEqual([]);
    expect(r.layout).toBe('unknown');
  });

  it('the registry picks no reader for a page it does not know', async () => {
    await open('swapcard-two-line.html');
    const picks = await page.evaluate(() => {
      const R = (globalThis as any).EDReaders;
      return [R.pick('https://www.brella.io/events/x/people', document), R.pick('http://app.swapcard.com/event/x/people', document), R.pick('https://swapcard.com.evil.example/event/x/people', document), R.pick('https://app.swapcard.com/event/x/people', document)?.id];
    });
    await page.close();
    expect(picks).toEqual([null, null, null, 'swapcard']);
  });
});

// ------------------------------------------------- the unpacked extension in Chrome

type DeskCall = { method: string; url: string; auth: string | undefined; body: any };

d('the unpacked extension in Chrome', () => {
  let desk: Server; let deskPort = 0; const calls: DeskCall[] = [];
  let ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let profile = '';
  let extId = '';
  let loadProblem = '';
  const added = new Map<string, any>();

  const readBody = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); });

  beforeAll(async () => {
    desk = createServer(async (req, res) => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      if (req.headers.authorization !== 'Bearer ed_test_key') { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'That key is not valid.' })); return; }
      if (req.url === '/api/capture/events') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'evt1', name: 'AWS Demo Summit', starts_on: '2026-12-02', venue: 'Las Vegas', stage: 'approved', reads: 3 }, { id: 'evt2', name: 'Fintech Forum', starts_on: '2027-02-10', venue: 'London', stage: 'requested', reads: 0 }]));
        return;
      }
      if (req.url === '/api/capture/people') {
        let a = 0; let already = 0;
        for (const p of body.people) { const k = p.profile_url; if (added.has(k)) already++; else { added.set(k, p); a++; } }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ added: a, already_in: already, to_check: 0 }));
        return;
      }
      res.writeHead(404, cors); res.end('{}');
    });
    await new Promise<void>((ok, bad) => {
      const tryPort = (p: number) => { desk.once('error', (e: any) => (e.code === 'EADDRINUSE' && p < 8960 ? tryPort(p + 1) : bad(e))); desk.listen(p, '127.0.0.1', () => { deskPort = p; ok(); }); };
      tryPort(8931);
    });
    try {
      profile = mkdtempSync(join(tmpdir(), 'ed-ext-'));
      ctx = await chromium.launchPersistentContext(profile, {
        executablePath: CHROME, headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--headless=new', '--enable-unsafe-extension-debugging'],
      });
      // Branded Chrome 137 and later ignores --load-extension, so the unpacked extension is
      // loaded through the DevTools Extensions domain (needs --enable-unsafe-extension-debugging).
      const cdp = await ctx.browser()!.newBrowserCDPSession();
      const r = await cdp.send('Extensions.loadUnpacked' as any, { path: EXT } as any) as any;
      extId = r.id;
      if (!ctx.serviceWorkers().some((w) => w.url().includes(extId))) await ctx.waitForEvent('serviceworker', { timeout: 10_000 });
    } catch (e: any) {
      loadProblem = String(e?.message || e).split('\n')[0];
    }
  }, 90_000);

  afterAll(async () => {
    await ctx?.close().catch(() => {});
    await new Promise((ok) => desk.close(ok));
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  const needExt = () => { if (loadProblem || !ctx) throw new Error(`Chrome would not load the extension here: ${loadProblem}`); };

  it('loads, and its service worker is the one in the manifest', async () => {
    needExt();
    const sw = ctx!.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`))!;
    expect(sw.url()).toMatch(/\/background\.js$/);
    const m = await sw.evaluate(() => (globalThis as any).chrome.runtime.getManifest());
    expect(m.permissions.sort()).toEqual(['activeTab', 'scripting', 'storage']);
  });

  it('the popup lists events from the desk with the Bearer key, and remembers the pick', async () => {
    needExt();
    const sw = ctx!.serviceWorkers().find((w) => w.url().includes(extId))!;
    await sw.evaluate(async (port) => { await (globalThis as any).chrome.storage.local.set({ deskUrl: `http://127.0.0.1:${port}`, captureKey: 'ed_test_key', eventId: '' }); }, deskPort);
    const pop = await ctx!.newPage();
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.waitForSelector('#events input[type=radio]');
    expect(await pop.locator('#events label').count()).toBe(2);
    expect(await pop.locator('#events b').allTextContents()).toEqual(['AWS Demo Summit', 'Fintech Forum']);
    const ev = calls.find((c) => c.url === '/api/capture/events')!;
    expect(ev.auth).toBe('Bearer ed_test_key');
    await pop.locator('#events label').first().click();
    const stored = await sw.evaluate(() => (globalThis as any).chrome.storage.local.get('eventId'));
    expect(stored.eventId).toBe('evt1');
    expect(await pop.locator('#setup').isHidden()).toBe(true);
    await pop.close();
  });

  it('a bad key shows the desk\'s plain sentence in the popup', async () => {
    needExt();
    const sw = ctx!.serviceWorkers().find((w) => w.url().includes(extId))!;
    await sw.evaluate(() => (globalThis as any).chrome.storage.local.set({ captureKey: 'wrong' }));
    const pop = await ctx!.newPage();
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.waitForFunction(() => document.getElementById('work-msg')!.textContent!.includes('not valid'));
    await sw.evaluate(() => (globalThis as any).chrome.storage.local.set({ captureKey: 'ed_test_key' }));
    await pop.close();
  });

  it('nothing is injected into a page unless the person pressed a button (no activeTab grant, no host access)', async () => {
    needExt();
    const sw = ctx!.serviceWorkers().find((w) => w.url().includes(extId))!;
    const page = await ctx!.newPage();
    await page.route('https://app.swapcard.com/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'swapcard-two-line.html'), 'utf8') }));
    await page.goto(PEOPLE_URL);
    const outcome = await sw.evaluate(async (url) => {
      const tabs = await (globalThis as any).chrome.tabs.query({ url });
      try { await (globalThis as any).chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: () => 1 }); return 'injected'; }
      catch (e: any) { return 'refused: ' + String(e.message).slice(0, 80); }
    }, PEOPLE_URL);
    await page.close();
    expect(outcome).toMatch(/^refused/);
  });

  it('the injected files, run as the extension would inject them, scroll the virtualized page and hand every person to the desk', async () => {
    needExt();
    added.clear(); const before = calls.length;
    const page = await ctx!.newPage();
    await page.setViewportSize({ width: 700, height: 500 });
    await page.route('https://app.swapcard.com/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'swapcard-virtualized.html'), 'utf8') }));
    await page.goto(PEOPLE_URL);
    // Stand-in for the service worker's batch handler: forwards to the fake desk with the key.
    const done: any[] = [];
    await page.exposeFunction('__toDesk', async (msg: any) => {
      if (msg.type === 'ed:done') { done.push(msg); return { ok: true }; }
      const res = await fetch(`http://127.0.0.1:${deskPort}/api/capture/people`, { method: 'POST', headers: { Authorization: 'Bearer ed_test_key', 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: 'evt1', platform: msg.platform, page_url: msg.pageUrl, people: msg.people }) });
      return { ok: res.ok };
    });
    await page.evaluate(() => { (globalThis as any).chrome = { runtime: { sendMessage: (m: any) => (globalThis as any).__toDesk(m) } }; });
    for (const f of ['readers/swapcard.js', 'readers/index.js', 'scroll.js', 'inject.js']) await page.addScriptTag({ path: join(EXT, f) });
    await page.evaluate(() => (globalThis as any).EDRun.start({ mode: 'scroll', scroll: { minDelay: 20, maxDelay: 40 } }));
    await page.waitForFunction(() => true);
    const t0 = Date.now();
    while (!done.length && Date.now() - t0 < 30_000) await page.waitForTimeout(100);
    await page.close();
    expect(done).toHaveLength(1);
    expect(['bottom', 'idle']).toContain(done[0].reason);
    expect(added.size).toBe(40);
    const posts = calls.slice(before).filter((c) => c.url === '/api/capture/people');
    expect(posts.every((c) => c.body.people.length <= 200 && c.body.platform === 'swapcard' && c.auth === 'Bearer ed_test_key')).toBe(true);
  }, 60_000);

  it('a changed layout reaches the runner as layout_changed, and a non-directory page as not_a_directory', async () => {
    needExt();
    const results: string[] = [];
    for (const [url, fixture] of [[PEOPLE_URL, 'swapcard-layout-changed.html'], ['https://app.swapcard.com/home', 'swapcard-layout-changed.html']] as const) {
      const page = await ctx!.newPage();
      await page.route('https://app.swapcard.com/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, fixture), 'utf8') }));
      await page.goto(url);
      const done: any[] = [];
      await page.exposeFunction('__toDesk', async (msg: any) => { if (msg.type === 'ed:done') done.push(msg); return { ok: true }; });
      await page.evaluate(() => { (globalThis as any).chrome = { runtime: { sendMessage: (m: any) => (globalThis as any).__toDesk(m) } }; });
      for (const f of ['readers/swapcard.js', 'readers/index.js', 'scroll.js', 'inject.js']) await page.addScriptTag({ path: join(EXT, f) });
      await page.evaluate(() => (globalThis as any).EDRun.start({ mode: 'once' }));
      const t0 = Date.now();
      while (!done.length && Date.now() - t0 < 10_000) await page.waitForTimeout(50);
      results.push(done[0]?.reason);
      await page.close();
    }
    expect(results).toEqual(['layout_changed', 'not_a_directory']);
  });
});

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
describe("every extension script parses", () => {
  const files = ["extension", "extension/readers"].flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".js")).map((f) => `${d}/${f}`));
  for (const f of files) it(`${f} is valid JavaScript`, () => { execFileSync("node", ["--check", f]); });
});
