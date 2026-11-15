/* Injected into the active tab only when the person presses a button in the
   popup (chrome.scripting.executeScript). Loaded after readers/swapcard.js,
   readers/index.js and scroll.js. It reads what is on the page, sends new
   people to the extension's service worker, and nothing else. It stops when the
   person presses Stop, switches tab or leaves the page. */
(function (root) {
  'use strict';
  if (root.EDRun && root.EDRun.stop) root.EDRun.stop();

  var BATCH = 200;
  var current = null;

  function keyOf(p) {
    return (p.profile_url || (p.name + '|' + p.company)).toLowerCase();
  }

  function send(msg) {
    try {
      return Promise.resolve(root.chrome.runtime.sendMessage(msg)).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function start(opts) {
    opts = opts || {};
    if (current) current.stop();
    var doc = root.document;
    var reader = root.EDReaders && root.EDReaders.pick(root.location.href, doc);
    var seen = {};
    var total = 0;
    var ctl = root.EDScroll.create(opts.scroll || {});
    var finished = false;

    function stopNow() { ctl.stop(); }
    function onHide() { if (doc.visibilityState === 'hidden') stopNow(); }
    doc.addEventListener('visibilitychange', onHide);
    root.addEventListener('pagehide', stopNow);

    function done(reason, extra) {
      if (finished) return Promise.resolve();
      finished = true;
      doc.removeEventListener('visibilitychange', onHide);
      root.removeEventListener('pagehide', stopNow);
      return send({ type: 'ed:done', reason: reason, read: total, layout: extra && extra.layout, readerId: reader && reader.id });
    }

    async function pass() {
      var res = reader.read(doc);
      if (res.layout === 'unknown' && total === 0) return { layout: 'unknown', newPeople: 0, total: total, fatal: false };
      var fresh = [];
      for (var i = 0; i < res.people.length; i++) {
        var k = keyOf(res.people[i]);
        if (seen[k]) continue;
        seen[k] = 1;
        fresh.push(res.people[i]);
      }
      var room = ctl.config.maxPeople - total;
      if (fresh.length > room) fresh = fresh.slice(0, Math.max(0, room));
      total += fresh.length;
      for (var j = 0; j < fresh.length; j += BATCH) {
        var reply = await send({
          type: 'ed:batch',
          platform: reader.id,
          pageUrl: root.location.href,
          people: fresh.slice(j, j + BATCH),
          read: total
        });
        if (!reply || reply.ok === false) return { layout: res.layout, newPeople: fresh.length, total: total, fatal: true };
      }
      return { layout: res.layout, newPeople: fresh.length, total: total, fatal: false };
    }

    async function go() {
      if (!reader) { await done('not_a_directory'); return; }
      var first = await pass();
      if (first.fatal) { await done('send_failed'); return; }
      if (first.layout === 'unknown' && first.total === 0) { await done('layout_changed', { layout: 'unknown' }); return; }
      if (opts.mode !== 'scroll') { await done('read_once'); return; }
      var env = {
        height: function () { return root.innerHeight; },
        atBottom: function () {
          var el = doc.scrollingElement || doc.documentElement;
          return Math.ceil(root.scrollY + root.innerHeight) >= el.scrollHeight - 2;
        },
        scrollStep: function (px) { root.scrollBy({ top: px, left: 0, behavior: 'instant' }); },
        sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
        readNew: async function () {
          var r = await pass();
          if (r.fatal) { ctl.stop(); return { stop: true, reason: 'send_failed', newPeople: 0, total: total }; }
          return { newPeople: r.newPeople, total: r.total };
        }
      };
      var outcome = await ctl.run(env, total);
      await done(outcome.reason || 'stopped');
    }

    current = { stop: stopNow };
    go().catch(function () { return done('error'); });
    return { started: true, reader: reader ? reader.id : null };
  }

  function stop() { if (current) current.stop(); }

  root.EDRun = { start: start, stop: stop };
})(typeof globalThis !== 'undefined' ? globalThis : this);
