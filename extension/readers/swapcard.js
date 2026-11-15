/* Swapcard web reader. Reads only what is on the page now and returns it.
   It does not send anything, store anything or follow any link.
   A person card is found from the profile link (path /person/<id>), never from
   class names, which are generated and change. */
(function (root) {
  'use strict';
  var PERSON_PATH = /\/person\/([^\/?#]+)/;
  var STOP_TAGS = { BODY: 1, HTML: 1, MAIN: 1, UL: 1, OL: 1, SECTION: 1, TABLE: 1, TBODY: 1, NAV: 1 };
  var CARD_TAGS = { LI: 1, ARTICLE: 1, TR: 1 };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, SVG: 1, BUTTON: 1, NOSCRIPT: 1, TEMPLATE: 1, SELECT: 1 };
  var SPLITS = [' at ', ' @ ', ' | '];

  function hostOk(host) {
    return host === 'swapcard.com' || /\.swapcard\.com$/.test(host);
  }

  function matches(url, doc) {
    var u;
    try { u = new URL(url); } catch (e) { return false; }
    if (u.protocol !== 'https:' || !hostOk(u.hostname)) return false;
    if (/\/event\/[^\/]+\/(people|attendees|participants|directory)/i.test(u.pathname)) return true;
    return !!(doc && personAnchors(doc).length);
  }

  function personId(a) {
    var href = a.getAttribute('href') || '';
    var m = PERSON_PATH.exec(href.split(/[?#]/)[0]);
    return m ? m[1] : null;
  }

  function personAnchors(doc) {
    var all = doc.querySelectorAll('a[href]');
    var out = [];
    for (var i = 0; i < all.length; i++) if (personId(all[i])) out.push(all[i]);
    return out;
  }

  function idsIn(el) {
    var ids = {};
    var n = 0;
    var as = el.querySelectorAll('a[href]');
    for (var i = 0; i < as.length; i++) {
      var id = personId(as[i]);
      if (id && !ids[id]) { ids[id] = 1; n++; }
    }
    if (el.tagName === 'A') {
      var own = personId(el);
      if (own && !ids[own]) n++;
    }
    return n;
  }

  /* Climb from the link to the largest ancestor that still holds exactly one
     person (the card), without crossing a list, section or page boundary. */
  function cardOf(anchor) {
    var node = anchor;
    while (node.parentElement) {
      if (CARD_TAGS[node.tagName]) break;
      var p = node.parentElement;
      if (STOP_TAGS[p.tagName]) break;
      if (idsIn(p) !== 1) break;
      node = p;
    }
    return node;
  }

  function hidden(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (SKIP_TAGS[n.tagName.toUpperCase()]) return true;
      if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden')) return true;
    }
    return false;
  }

  function linesOf(card) {
    var doc = card.ownerDocument;
    var walker = doc.createTreeWalker(card, 4 /* SHOW_TEXT */);
    var lines = [];
    var node;
    while ((node = walker.nextNode())) {
      var t = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (hidden(node.parentElement)) continue;
      if (lines.length && lines[lines.length - 1] === t) continue;
      lines.push(t);
    }
    if (lines.length > 1 && /^[A-Z]{1,3}$/.test(lines[0])) lines.shift();
    return lines;
  }

  function splitOne(line) {
    for (var i = 0; i < SPLITS.length; i++) {
      var at = line.indexOf(SPLITS[i]);
      if (at > 0) {
        return [line.slice(0, at).trim(), line.slice(at + SPLITS[i].length).trim()];
      }
    }
    return [line, ''];
  }

  function fromLines(lines) {
    var name = lines[0] || '';
    var title = '';
    var company = '';
    var location = '';
    if (lines.length === 2) {
      var s = splitOne(lines[1]);
      title = s[0]; company = s[1];
    } else if (lines.length >= 3) {
      title = lines[1]; company = lines[2];
      location = lines[3] || '';
    }
    return { name: name, title: title, company: company, location: location };
  }

  function read(doc) {
    var seen = {};
    var people = [];
    var anchors = personAnchors(doc);
    for (var i = 0; i < anchors.length; i++) {
      var id = personId(anchors[i]);
      if (seen[id]) continue;
      seen[id] = 1;
      var card = cardOf(anchors[i]);
      var lines = linesOf(card);
      if (!lines.length) continue;
      var p = fromLines(lines);
      if (!p.name) continue;
      p.profile_url = anchors[i].href || '';
      people.push(p);
    }
    return { people: people, layout: people.length ? 'ok' : 'unknown' };
  }

  root.EDReader_swapcard = {
    id: 'swapcard',
    label: 'Swapcard',
    matches: matches,
    read: read
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
