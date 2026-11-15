/* The reader registry. It lists the readers that exist; there are no stubs for
   platforms that have none. pick returns the first reader whose matches is true. */
(function (root) {
  'use strict';
  var list = [root.EDReader_swapcard].filter(Boolean);
  function pick(url, doc) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].matches(url, doc)) return list[i];
    }
    return null;
  }
  root.EDReaders = { list: list, pick: pick };
})(typeof globalThis !== 'undefined' ? globalThis : this);
