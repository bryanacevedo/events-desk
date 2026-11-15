/* The scroll controller: pure rules plus one loop. No page access here; the
   page is reached only through the env object the caller passes in.
   Loaded as a plain script into the page (EDScroll) and read by the tests. */
(function (root) {
  'use strict';
  var DEFAULTS = {
    stepFraction: 0.7,
    minDelay: 800,
    maxDelay: 1800,
    maxEmptySteps: 3,
    maxPeople: 1500
  };

  function create(options) {
    var cfg = {};
    var k;
    for (k in DEFAULTS) cfg[k] = DEFAULTS[k];
    options = options || {};
    for (k in options) if (options[k] !== undefined) cfg[k] = options[k];
    var random = typeof cfg.random === 'function' ? cfg.random : Math.random;
    var now = typeof cfg.now === 'function' ? cfg.now : Date.now;
    var stopped = false;
    var emptySteps = 0;
    var dueAt = 0;
    var lastReason = null;

    function stepSize(windowHeight) {
      return Math.max(1, Math.round(windowHeight * cfg.stepFraction));
    }
    function nextDelay() {
      var r = random();
      if (!(r >= 0)) r = 0;
      if (r > 1) r = 1;
      return Math.round(cfg.minDelay + r * (cfg.maxDelay - cfg.minDelay));
    }
    function scheduleNext() {
      var d = nextDelay();
      dueAt = now() + d;
      return { delay: d, dueAt: dueAt };
    }
    function isDue() { return now() >= dueAt; }
    function stop() { stopped = true; }

    /* Called after each step has scrolled, waited and read.
       info: { newPeople: number, total: number, atBottom: boolean }
       Returns { stop: boolean, reason: null | 'stopped' | 'limit' | 'bottom' | 'idle' } */
    function record(info) {
      info = info || {};
      if (stopped) return finish('stopped');
      if (info.newPeople > 0) emptySteps = 0; else emptySteps += 1;
      if (info.total >= cfg.maxPeople) return finish('limit');
      if (info.atBottom) return finish('bottom');
      if (emptySteps >= cfg.maxEmptySteps) return finish('idle');
      return { stop: false, reason: null };
    }
    function finish(reason) {
      lastReason = reason;
      return { stop: true, reason: reason };
    }

    /* env: { height(): number, atBottom(): boolean, scrollStep(px): void,
              readNew(): Promise<{ newPeople, total }>, sleep(ms): Promise }
       The caller has already made its first read before calling run. */
    function run(env, startTotal) {
      var total = startTotal || 0;
      function loop() {
        if (stopped) return Promise.resolve(finish('stopped'));
        if (total >= cfg.maxPeople) return Promise.resolve(finish('limit'));
        env.scrollStep(stepSize(env.height()));
        var s = scheduleNext();
        return env.sleep(s.delay).then(function () {
          if (stopped) return finish('stopped');
          return env.readNew();
        }).then(function (res) {
          if (res && res.stop) return res;
          if (res && res.reason === 'stopped') return res;
          total = res.total;
          var d = record({ newPeople: res.newPeople, total: total, atBottom: env.atBottom() });
          return d.stop ? d : loop();
        });
      }
      return loop();
    }

    return {
      config: cfg,
      stepSize: stepSize,
      nextDelay: nextDelay,
      scheduleNext: scheduleNext,
      isDue: isDue,
      record: record,
      run: run,
      stop: stop,
      get stopped() { return stopped; },
      get emptySteps() { return emptySteps; },
      get reason() { return lastReason; }
    };
  }

  root.EDScroll = { create: create, DEFAULTS: DEFAULTS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
