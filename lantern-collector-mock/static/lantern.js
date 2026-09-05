/*! Lumenview Lantern Web SDK 4.11.2 (Meridian hosted copy) - mock build for the local estate.
 *  Exposes window.Lantern with track / page / identify / group / reset and a queue that buffers
 *  calls made before load() has run, exactly like the vendor snippet does. Events are POSTed to
 *  the collector in batches. Nothing here is real vendor code.
 */
(function (window, document) {
  'use strict';

  var existing = window.Lantern;
  var pending = existing && existing.q ? existing.q.slice() : [];

  var state = {
    writeKey: null,
    endpoint: null,
    sessionId: null,
    anonymousId: null,
    userId: null,
    traits: {},
    queue: [],
    flushTimer: null,
    flushIntervalMs: 2000,
    maxBatch: 20,
    loaded: false,
    debug: false
  };

  function uuid() {
    var s = [];
    var hex = '0123456789abcdef';
    for (var i = 0; i < 36; i++) s[i] = hex.substr(Math.floor(Math.random() * 16), 1);
    s[14] = '4';
    s[19] = hex.substr((parseInt(s[19], 16) & 0x3) | 0x8, 1);
    s[8] = s[13] = s[18] = s[23] = '-';
    return s.join('');
  }

  function storage(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
      return value;
    } catch (e) {
      return null;
    }
  }

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function writeCookie(name, value, maxAgeSeconds) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAgeSeconds + '; samesite=lax';
  }

  function ensureIds() {
    if (!state.anonymousId) {
      state.anonymousId = storage('lantern_anon_id') || storage('lantern_anon_id', uuid());
    }
    if (!state.sessionId) {
      state.sessionId = readCookie('lantern_sid') || uuid();
      writeCookie('lantern_sid', state.sessionId, 30 * 60);
    }
  }

  function log() {
    if (state.debug && window.console) window.console.log.apply(window.console, ['[lantern]'].concat([].slice.call(arguments)));
  }

  function context() {
    return {
      page: { path: window.location.pathname, url: window.location.href, title: document.title, referrer: document.referrer },
      userAgent: window.navigator.userAgent,
      locale: window.navigator.language,
      screen: { width: window.screen.width, height: window.screen.height },
      library: { name: 'lantern.js', version: '4.11.2-mock' }
    };
  }

  function enqueue(type, payload) {
    ensureIds();
    var event = {
      type: type,
      messageId: uuid(),
      timestamp: new Date().toISOString(),
      writeKey: state.writeKey,
      sessionId: state.sessionId,
      anonymousId: state.anonymousId,
      userId: state.userId,
      context: context()
    };
    for (var k in payload) if (payload.hasOwnProperty(k)) event[k] = payload[k];
    state.queue.push(event);
    log('queued', type, event);
    if (state.queue.length >= state.maxBatch) flush();
    else scheduleFlush();
    return event;
  }

  function scheduleFlush() {
    if (state.flushTimer || !state.loaded) return;
    state.flushTimer = window.setTimeout(flush, state.flushIntervalMs);
  }

  function flush(useBeacon) {
    if (state.flushTimer) {
      window.clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (!state.loaded || state.queue.length === 0) return;
    var batch = state.queue.splice(0, state.maxBatch);
    var body = JSON.stringify({ batch: batch, sentAt: new Date().toISOString(), writeKey: state.writeKey });
    var url = state.endpoint + '/v1/batch';
    if (useBeacon && window.navigator.sendBeacon) {
      window.navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    try {
      var xhr = new window.XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-Lantern-Write-Key', state.writeKey || '');
      xhr.setRequestHeader('X-Lantern-Session', state.sessionId);
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4 && xhr.status >= 400) {
          log('collector rejected batch', xhr.status);
          // vendor behaviour: put the batch back once, then drop it
          if (!batch._retried) {
            batch._retried = true;
            state.queue = batch.concat(state.queue);
          }
        }
      };
      xhr.send(body);
    } catch (e) {
      log('send failed', e);
    }
    if (state.queue.length > 0) scheduleFlush();
  }

  var Lantern = {
    VERSION: '4.11.2-mock',
    q: [],

    load: function (writeKey, options) {
      options = options || {};
      state.writeKey = writeKey;
      state.endpoint = (options.endpoint || (document.currentScript && document.currentScript.src
        ? document.currentScript.src.replace(/\/lantern(\.min)?\.js.*$/, '') : window.location.origin)).replace(/\/$/, '');
      state.debug = !!options.debug;
      if (options.flushIntervalMs) state.flushIntervalMs = options.flushIntervalMs;
      ensureIds();
      state.loaded = true;
      log('loaded', state.endpoint);
      var replay = pending.concat(Lantern.q);
      Lantern.q = [];
      pending = [];
      for (var i = 0; i < replay.length; i++) {
        var call = replay[i];
        var method = call[0];
        if (method !== 'load' && typeof Lantern[method] === 'function') Lantern[method].apply(Lantern, [].slice.call(call, 1));
      }
      scheduleFlush();
    },

    track: function (event, properties) {
      if (!event) return null;
      return enqueue('track', { event: event, properties: properties || {} });
    },

    page: function (name, properties) {
      if (typeof name === 'object' && name !== null) {
        properties = name;
        name = undefined;
      }
      return enqueue('page', { name: name || document.title, properties: properties || {} });
    },

    identify: function (userId, traits) {
      if (typeof userId === 'object' && userId !== null) {
        traits = userId;
        userId = state.userId;
      }
      if (userId) state.userId = String(userId);
      state.traits = traits || {};
      return enqueue('identify', { traits: state.traits });
    },

    group: function (groupId, traits) {
      return enqueue('group', { groupId: groupId, traits: traits || {} });
    },

    reset: function () {
      state.userId = null;
      state.traits = {};
      state.sessionId = uuid();
      writeCookie('lantern_sid', state.sessionId, 30 * 60);
    },

    flush: function () {
      flush(false);
    },

    getSessionId: function () {
      ensureIds();
      return state.sessionId;
    },

    getAnonymousId: function () {
      ensureIds();
      return state.anonymousId;
    },

    ready: function (fn) {
      if (state.loaded) fn();
      else Lantern.q.push(['ready', fn]);
    },

    queueLength: function () {
      return state.queue.length;
    }
  };

  // calls made before this script finished loading arrive as [method, ...args] tuples on window.Lantern.q
  Lantern.q = existing && existing.q ? existing.q.slice() : [];
  pending = [];

  window.Lantern = Lantern;
  window.addEventListener('pagehide', function () { flush(true); });
  window.addEventListener('beforeunload', function () { flush(true); });

  // auto-load when the tag carries data-write-key
  var script = document.currentScript;
  if (script && script.getAttribute('data-write-key')) {
    Lantern.load(script.getAttribute('data-write-key'), { endpoint: script.getAttribute('data-endpoint'), debug: script.getAttribute('data-debug') === 'true' });
  }
})(window, document);
