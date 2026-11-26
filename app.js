'use strict';
/**
 * Tide Notes phone dashboard. All names and content live only in the encrypted
 * data file. This file draws the unlocked boards: bots, usage, projects, and
 * the waiting list. It depends on data.enc.json and the Web Crypto API.
 */
(() => {
  const DATA_URL = 'data.enc.json';
  const DB = 'k',
    STORE = 'k',
    KEY_ID = 'main';
  const root = document.getElementById('root');
  // Live countdown on the usage meters; cleared on lock or redraw.
  let usageTick = 0;
  const enc = new TextEncoder(),
    dec = new TextDecoder();
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // ---- tiny DOM helper (text only, never innerHTML) ----
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.assign(el.style, v);
      else el.setAttribute(k === 'className' ? 'class' : k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat())
      if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  // ---- key storage: non-extractable AES key in IndexedDB ----
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kv(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  }
  const getKey = () => kv('readonly', (s) => s.get(KEY_ID)).catch(() => null);
  const putKey = (k) => kv('readwrite', (s) => s.put(k, KEY_ID));
  // fail closed: if the stored key can't be deleted, wipe the whole database; if that fails too, block auto-unlock for this tab
  let keyBlocked = false;
  const dropKey = () =>
    kv('readwrite', (s) => s.delete(KEY_ID)).catch(
      () =>
        new Promise((res) => {
          keyBlocked = true;
          try {
            const r = indexedDB.deleteDatabase(DB);
            r.onsuccess = r.onerror = r.onblocked = () => res();
          } catch {
            res();
          }
        }),
    );
  const dropDataCache = () =>
    'caches' in self ? caches.delete('data').catch(() => {}) : Promise.resolve();

  async function deriveKey(pass, env) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, [
      'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64(env.salt), iterations: env.iter },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
  }
  async function decrypt(key, env) {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64(env.iv), additionalData: enc.encode('v' + env.v) },
      key,
      b64(env.ct),
    );
    return JSON.parse(dec.decode(pt));
  }
  async function fetchEnv() {
    const r = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('fetch ' + r.status);
    const env = await r.json();
    if (
      env.v !== 1 ||
      env.kdf !== 'PBKDF2-SHA256' ||
      !(Number.isInteger(env.iter) && env.iter >= 310000 && env.iter <= 5000000)
    )
      throw new Error('bad format');
    return env;
  }

  // ---- lock screen ----
  function showLock(env, msg) {
    const err = h('div', { className: 'err' }, msg || '');
    const pass = h('input', {
      type: 'password',
      autocomplete: 'current-password',
      placeholder: 'Passphrase',
      'aria-label': 'Passphrase',
    });
    const keep = h('input', { type: 'checkbox', checked: true });
    const btn = h('button', { type: 'submit' }, 'Unlock');
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          err.textContent = 'Unlocking…';
          try {
            const e2 = env || (await fetchEnv());
            const key = await deriveKey(pass.value, e2);
            const data = await decrypt(key, e2);
            pass.value = '';
            if (keep.checked) await putKey(key);
            sessionKey = key;
            render(data, e2);
          } catch (x) {
            err.textContent = 'That did not unlock it. Check the passphrase.';
            btn.disabled = false;
          }
        },
      },
      h('div', { className: 'dot' }),
      pass,
      h('label', {}, keep, 'Remember on this phone'),
      btn,
      err,
    );
    root.replaceChildren(h('div', { className: 'lock' }, form));
    pass.focus();
  }

  // ---- dashboard ----
  let sessionKey = null,
    current = null,
    speakTimer = null;
  const PARTICLES = [
    [8, 12, 0, 3],
    [18, 78, 1.2, 2],
    [26, 6, 2.4, 4],
    [34, 91, 0.6, 2],
    [48, 4, 3.1, 3],
    [56, 86, 1.8, 2],
    [64, 22, 4, 3],
    [72, 70, 2.7, 2],
    [80, 15, 0.9, 3],
    [12, 48, 3.6, 2],
    [88, 54, 1.5, 4],
    [40, 62, 2.1, 2],
  ];
  const label = (s) =>
    ({
      online: 'Online',
      paused: 'Paused',
      blocked: 'Blocked',
      standby: 'Standby',
      offline: 'Offline',
    })[s] || 'Idle';
  // Projects: percent is an estimate (clamped 0-100); state says whether work is moving or blocked on someone.
  const STATES = {
    processing: 'Processing',
    waiting: 'Waiting',
    done: 'Done',
    canceled: 'Canceled',
  };
  const STALE_MS = 14 * 24 * 60 * 60 * 1000;
  const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const projState = (p) => (STATES[p.state] ? p.state : 'processing');
  const statusVerb = (state) => {
    if (state === 'done') {
      return 'Done: ';
    }
    if (state === 'canceled') {
      return 'Canceled: ';
    }
    return 'Now: ';
  };

  /** Last-touch instant from updatedAt (ISO). Zero if the stamp is missing. */
  const touchedMs = (p) => {
    const ms = Date.parse(p && p.updatedAt ? p.updatedAt : '');
    return Number.isFinite(ms) ? ms : 0;
  };
  const sortByTouch = (list) =>
    list.slice().sort((a, b) => {
      const diff = touchedMs(b) - touchedMs(a);
      return diff !== 0 ? diff : String(a.name || '').localeCompare(String(b.name || ''));
    });

  /** Open work with no update for 14 days is stale; done and canceled are not. */
  const projectIsStale = (p) => {
    const state = projState(p);
    if (state === 'done' || state === 'canceled') {
      return false;
    }
    const ms = touchedMs(p);
    return ms > 0 && Date.now() - ms >= STALE_MS;
  };

  function projectCard(p) {
    const state = projState(p);
    const v = pct(p.percent);
    const stale = projectIsStale(p);
    const line =
      state === 'waiting'
        ? h(
            'div',
            { className: 'proj-status waiting' },
            h('b', {}, 'Waiting on: '),
            p.waiting_on || p.status || 'not stated',
          )
        : h(
            'div',
            { className: 'proj-status ' + state },
            h('b', {}, statusVerb(state)),
            p.status || '',
          );
    const chips = [h('span', { className: 'chip ' + state }, STATES[state])];
    if (stale) {
      chips.push(h('span', { className: 'chip stale-tag' }, 'Stale'));
    }
    return h(
      'article',
      { className: 'proj ' + state + (stale ? ' is-stale' : '') },
      h(
        'div',
        { className: 'proj-head' },
        h('h3', { className: 'proj-name' }, p.name),
        h('div', { className: 'chips' }, ...chips),
      ),
      h(
        'div',
        {
          className: 'bar',
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(v),
          'aria-valuetext': `about ${v}% (estimate)`,
          'aria-label': p.name + ' estimated progress',
        },
        h('div', { className: 'fill ' + state, 'aria-hidden': 'true', style: { width: v + '%' } }),
      ),
      h(
        'div',
        { className: 'proj-meta' },
        h('span', {}, `~${v}% est.`),
        h('span', {}, [p.owner, p.updated].filter(Boolean).join(' · ')),
      ),
      line,
      state === 'waiting' && p.status && p.waiting_on
        ? h('div', { className: 'proj-note' }, p.status)
        : null,
    );
  }

  function formatUsageAt(at) {
    const ms = Date.parse(at || '');
    if (!Number.isFinite(ms)) {
      return '';
    }
    return (
      new Date(ms).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }) + ' PT'
    );
  }

  function formatResetAt(at) {
    const ms = Date.parse(at || '');
    if (!Number.isFinite(ms)) {
      return '';
    }
    return (
      new Date(ms).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }) + ' PT'
    );
  }

  // Keep the same Pacific clock time when adding weeks, including across DST.
  function rollForwardReset(resetsAt, now) {
    let ms = Date.parse(resetsAt || '');
    if (!Number.isFinite(ms)) {
      return '';
    }
    const tz = 'America/Los_Angeles';
    const partsOf = (date) => {
      const map = {};
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .forEach((p) => {
          map[p.type] = p.value;
        });
      return map;
    };
    const civilDate = (year, month, day, hour, minute, second) => {
      const want = year + '-' + month + '-' + day + 'T' + hour + ':' + minute + ':' + second;
      for (const offset of ['-08:00', '-07:00']) {
        const date = new Date(want + offset);
        const p = partsOf(date);
        if (
          p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second ===
          want
        ) {
          return date.getTime();
        }
      }
      return NaN;
    };
    let guard = 0;
    while (ms <= now && guard < 60) {
      const p = partsOf(new Date(ms));
      const noon = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + 7, 12, 0, 0);
      const n = partsOf(new Date(noon));
      ms = civilDate(n.year, n.month, n.day, p.hour, p.minute, p.second);
      if (!Number.isFinite(ms)) {
        return '';
      }
      guard += 1;
    }
    return ms > now ? new Date(ms).toISOString() : '';
  }

  function formatTimeLeft(until, now) {
    const end = Date.parse(until || '');
    if (!Number.isFinite(end)) {
      return '';
    }
    let ms = end - now;
    if (ms < 0) {
      ms = 0;
    }
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / (60 * 24));
    const hours = Math.floor((totalMin % (60 * 24)) / 60);
    const minutes = totalMin % 60;
    return days + 'd ' + hours + 'h ' + minutes + 'm left';
  }

  function stopUsageCountdown() {
    if (usageTick) {
      clearInterval(usageTick);
      usageTick = 0;
    }
  }

  function startUsageCountdown() {
    stopUsageCountdown();
    const nodes = root.querySelectorAll('[data-resets-at]');
    if (!nodes.length) {
      return;
    }
    const tick = () => {
      const now = Date.now();
      nodes.forEach((el) => {
        const rolled = rollForwardReset(el.getAttribute('data-resets-at'), now);
        el.textContent = rolled ? formatTimeLeft(rolled, now) : 'reset time unknown';
      });
    };
    tick();
    usageTick = setInterval(tick, 30000);
  }

  function usageMeta(slot) {
    const parts = [];
    const updated = formatUsageAt(slot.at);
    if (updated) {
      parts.push('updated ' + updated);
    }
    const now = Date.now();
    const rolled = slot.resetsAt ? rollForwardReset(slot.resetsAt, now) : '';
    if (rolled) {
      parts.push('resets ' + formatResetAt(rolled));
      parts.push(
        h(
          'span',
          { className: 'usage-left', 'data-resets-at': rolled },
          formatTimeLeft(rolled, now),
        ),
      );
    } else {
      parts.push('reset time unknown');
    }
    const nodes = [];
    parts.forEach((part, i) => {
      if (i > 0) {
        nodes.push(' · ');
      }
      nodes.push(part);
    });
    return nodes;
  }

  function usageMeter(label, slot, stopAt) {
    if (!slot || typeof slot !== 'object') {
      return null;
    }
    const v = pct(slot.percent);
    const meta = usageMeta(slot);
    return h(
      'div',
      { className: 'usage-row' },
      h('span', { className: 'usage-label' }, label),
      h(
        'div',
        {
          className: 'usage-bar',
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(v),
          'aria-label':
            label +
            ' usage ' +
            v +
            ' percent. ' +
            meta
              .map((n) => (typeof n === 'string' ? n : n.textContent || ''))
              .join('')
              .replace(/\s+/g, ' ')
              .trim(),
        },
        h('div', {
          className: 'fill usage-fill',
          'aria-hidden': 'true',
          style: { width: v + '%' },
        }),
        stopAt != null
          ? h('span', {
              className: 'usage-stop',
              'aria-hidden': 'true',
              style: { left: pct(stopAt) + '%' },
              title: 'Stop at ' + pct(stopAt) + '%',
            })
          : null,
      ),
      h('span', { className: 'usage-pct' }, v + '%'),
      meta.length ? h('span', { className: 'usage-at' }, ...meta) : null,
    );
  }

  function usageBlock(usage) {
    if (!usage || typeof usage !== 'object') {
      return null;
    }
    const stopAt = Number.isFinite(usage.stopAt) ? usage.stopAt : 80;
    const grok = usageMeter('Grok Bot', usage.grokBot, stopAt);
    const claude = usageMeter('Claude', usage.claude, null);
    if (!grok && !claude) {
      return null;
    }
    return h(
      'section',
      { className: 'usage', 'aria-label': 'Usage' },
      h('h2', {}, 'USAGE'),
      grok,
      claude,
      h(
        'p',
        { className: 'usage-note' },
        'Dev work stops around ' + pct(stopAt) + '% Grok Bot usage. Claude can go to 100%.',
      ),
    );
  }

  function archiveSection(items) {
    if (!items.length) {
      return null;
    }
    return h(
      'details',
      { className: 'archive' },
      h('summary', {}, 'ARCHIVE ', h('span', { className: 'count' }, String(items.length))),
      ...items.map((p) => projectCard(p)),
    );
  }
  const lsGet = (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  };

  function render(data, env) {
    current = data;
    const st = {
      focus: false,
      selected: (data.bots[0] || {}).name,
      local: lsGet('local-' + (data.stamp || ''), {}),
    };
    const name = data.name || '';
    const bots = data.bots || [];
    const transcript = h(
      'div',
      { className: 'speech' },
      'Standing by' + (name ? ', ' + name : '') + '.',
    );
    const hud = h('div', { className: 'hud is-booting' });

    function speak(text) {
      transcript.textContent = text;
      hud.classList.add('is-speaking');
      clearTimeout(speakTimer);
      const done = () => hud.classList.remove('is-speaking');
      try {
        if (!window.speechSynthesis) throw 0;
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.pitch = 0.95;
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
      } catch {
        speakTimer = setTimeout(done, 3200);
      }
    }
    const decisions = () =>
      (data.decisions || []).map((d) => ({ ...d, state: st.local[d.id] || d.state || 'open' }));
    const open = () => decisions().filter((d) => d.state === 'open');
    const flagged = bots.filter((b) => b.status === 'paused' || b.status === 'blocked').length;
    const flagLine = () =>
      flagged === 0
        ? 'None are paused or blocked.'
        : `${flagged} ${flagged === 1 ? 'is' : 'are'} paused or blocked.`;
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    // Review S1: only strings reach the cards (odd data in the file can't blank the app); at most 50, text capped
    const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
    const cleanProject = (p) => ({
      name: str(p.name, 120),
      percent: p.percent,
      state: p.state,
      status: str(p.status),
      waiting_on: str(p.waiting_on),
      owner: str(p.owner, 60),
      updated: str(p.updated, 60),
      updatedAt: str(p.updatedAt, 40),
    });
    const pickProjects = (list) =>
      Array.isArray(list)
        ? sortByTouch(
            list
              .filter(
                (p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim(),
              )
              .slice(0, 50)
              .map(cleanProject),
          )
        : [];
    const projects = pickProjects(data.projects);
    const archived = pickProjects(data.archive);
    const projWaiting = () => projects.filter((p) => projState(p) === 'waiting');
    const projLine = () => {
      if (!projects.length) return '';
      const w = projWaiting();
      return ` ${n(projects.length, 'project', 'projects')} tracked, ${w.length} waiting${w.length ? ': ' + w.map((p) => `${p.name} on ${p.waiting_on || 'something'}`).join('; ') : ''}.`;
    };
    const computerLine = () => (data.computer ? data.computer.spoken || '' : '');

    const actions = {
      brief() {
        const o = open();
        const first = o[0]
          ? ` The one to do first is ${o[0].title.replace(/\.$/, '').toLowerCase()}.`
          : ' Nothing is waiting on you.';
        speak(
          `Good morning${name ? ', ' + name : ''}. ${n(bots.length, 'bot', 'bots')} on the roster. ${flagLine()} ${computerLine()} ${n(o.length, 'decision is', 'decisions are')} waiting.${projLine()}${first}`,
        );
      },
      status() {
        const u = data.usage || {};
        const stopAt = Number.isFinite(u.stopAt) ? u.stopAt : 80;
        const usageSpeak = (name, slot) => {
          if (!slot || !Number.isFinite(slot.percent)) {
            return '';
          }
          const rolled = slot.resetsAt ? rollForwardReset(slot.resetsAt, Date.now()) : '';
          const reset = rolled
            ? ` Reset ${formatResetAt(rolled)}, ${formatTimeLeft(rolled, Date.now())}.`
            : ' Reset time unknown.';
          return ` ${name} usage ${pct(slot.percent)} percent.${reset}`;
        };
        const grok = usageSpeak('Grok Bot', u.grokBot);
        const claude = usageSpeak('Claude', u.claude);
        const stop =
          grok || claude ? ` Development stops around ${pct(stopAt)} percent Grok Bot usage.` : '';
        speak(
          `Status report. ${flagLine()} ${data.statusLine || ''}${grok}${claude}${stop} ${n(open().length, 'decision is', 'decisions are')} in the queue. Data as of ${data.updated}.`,
        );
      },
      waiting() {
        const o = open();
        speak(
          o.length
            ? `${n(o.length, 'item needs', 'items need')} you. ${o.map((d) => d.title).join('. Next: ')}. Approve and Later only change this screen.`
            : 'Nothing is marked waiting on you.',
        );
      },
      projects() {
        speak(
          projects.length
            ? projects
                .slice(0, 8)
                .map(
                  (p) =>
                    `${p.name}, about ${pct(p.percent)} percent, ${projState(p) === 'waiting' ? 'waiting on ' + (p.waiting_on || p.status || 'something') : p.status || STATES[projState(p)]}`,
                )
                .join('. ') +
                '.' +
                (projects.length > 8 ? ` And ${projects.length - 8} more.` : '')
            : 'No projects listed yet.',
        );
      },
      focus() {
        st.focus = !st.focus;
        hud.classList.toggle('is-focus', st.focus);
        speak(st.focus ? 'Focus mode on. Panels dimmed, motion calmed.' : 'Focus mode off.');
        draw();
      },
    };
    function setLocal(id, state) {
      st.local[id] = state;
      localStorage.setItem('local-' + (data.stamp || ''), JSON.stringify(st.local));
      draw();
    }

    const ageH = (Date.now() - Date.parse(data.updatedIso || 0)) / 36e5;
    const body = h('div');
    function draw() {
      const o = open(),
        later = decisions().filter((d) => d.state === 'later');
      const sel = bots.find((b) => b.name === st.selected) || bots[0] || {};
      const c = data.computer;
      body.replaceChildren(
        ...[
          h(
            'header',
            { className: 'topbar' },
            h(
              'div',
              {},
              h('div', { className: 'brand' }, data.brand || ''),
              h('div', { className: 'sub' }, 'SYSTEMS ONLINE'),
            ),
            h(
              'div',
              { className: 'meta' },
              h(
                'span',
                { className: ageH > 24 ? 'stale' : '' },
                'Updated ' + (data.updated || '?'),
              ),
              h('div', {}, `${o.length} waiting · ${flagged} flagged`),
              h(
                'div',
                { className: 'tools' },
                h('button', { type: 'button', onclick: refresh }, 'Refresh'),
                h('button', { type: 'button', onclick: lock }, 'Lock'),
              ),
            ),
          ),
          usageBlock(data.usage),
          h(
            'div',
            { className: 'boards' },
            h(
              'section',
              { className: 'panel left' },
              h('h2', {}, 'SYSTEMS ', h('span', { className: 'count' }, bots.length)),
              bots.map((b) =>
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'bot' + (st.selected === b.name ? ' active' : ''),
                    onclick: () => {
                      st.selected = b.name;
                      draw();
                    },
                  },
                  h(
                    'div',
                    { className: 'bot-row' },
                    h('span', { className: 'light ' + (b.status || 'idle') }),
                    h('span', { className: 'bot-name' }, b.name),
                    h(
                      'span',
                      { className: 'bot-role', style: { marginLeft: 'auto' } },
                      label(b.status),
                    ),
                  ),
                  h('div', { className: 'bot-role' }, `${b.role} · owner ${b.owner}`),
                  h('div', { className: 'bot-last' }, b.last),
                ),
              ),
              sel.name
                ? h(
                    'div',
                    { className: 'limits', style: { marginTop: '8px' } },
                    `Selected: ${sel.name}. ${sel.limits || ''}`,
                  )
                : null,
              c
                ? h(
                    'div',
                    { className: 'item', style: { marginTop: '12px' } },
                    h('div', { className: 'from' }, 'COMPUTER'),
                    h(
                      'h3',
                      {},
                      h(
                        'span',
                        { className: 'bot-row' },
                        h('span', { className: 'light ' + (c.status || 'offline') }),
                        h('span', {}, c.name || ''),
                        h(
                          'span',
                          { className: 'bot-role', style: { marginLeft: 'auto' } },
                          label(c.status || 'offline'),
                        ),
                      ),
                    ),
                    h('div', { className: 'detail' }, c.detail || ''),
                  )
                : null,
            ),
            h(
              'section',
              { className: 'center' },
              h(
                'div',
                { className: 'core-wrap' },
                h('div', { className: 'ring r3' }),
                h('div', { className: 'ring r2' }),
                h('div', { className: 'ring r1' }),
                h('div', { className: 'wave' }),
                h('div', { className: 'core' }, h('span', {}, data.brand || '')),
              ),
              transcript,
            ),
            h(
              'section',
              { className: 'panel projects' },
              h(
                'h2',
                {},
                'PROJECTS ',
                h(
                  'span',
                  { className: 'count' },
                  projects.length ? `${projWaiting().length} waiting · ${projects.length}` : '0',
                ),
              ),
              projects.length
                ? projects.map((p) => projectCard(p))
                : h('div', { className: 'empty' }, 'No projects listed yet.'),
              archiveSection(archived),
            ),
            h(
              'section',
              { className: 'panel right' },
              h('h2', {}, 'WAITING ON YOU ', h('span', { className: 'count' }, o.length)),
              o.length ? null : h('div', { className: 'empty' }, 'No open items.'),
              o.map((d) =>
                h(
                  'article',
                  { className: 'item' },
                  h('div', { className: 'from' }, `${d.from} · ${d.since}`),
                  h('h3', {}, d.title),
                  h('div', { className: 'detail' }, d.detail),
                  h(
                    'div',
                    { className: 'actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'act primary',
                        onclick: () => setLocal(d.id, 'approved'),
                      },
                      'Approve',
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'act', onclick: () => setLocal(d.id, 'later') },
                      'Later',
                    ),
                  ),
                ),
              ),
              later.length
                ? h(
                    'div',
                    { className: 'later-wrap' },
                    h('h2', {}, 'LATER ', h('span', { className: 'count' }, later.length)),
                    later.map((d) =>
                      h(
                        'article',
                        { className: 'item', onclick: () => setLocal(d.id, 'open') },
                        h('div', { className: 'from' }, `${d.from} · parked (tap to reopen)`),
                        h('h3', {}, d.title),
                      ),
                    ),
                  )
                : null,
            ),
          ),
          h(
            'div',
            { className: 'command' },
            h(
              'div',
              { className: 'cmds' },
              h(
                'button',
                { type: 'button', className: 'cmd', onclick: actions.brief },
                'Morning brief',
              ),
              h('button', { type: 'button', className: 'cmd', onclick: actions.status }, 'Status'),
              h(
                'button',
                { type: 'button', className: 'cmd', onclick: actions.waiting },
                "What's waiting",
              ),
              h(
                'button',
                { type: 'button', className: 'cmd', onclick: actions.projects },
                'Projects',
              ),
              h(
                'button',
                { type: 'button', className: 'cmd', onclick: actions.focus },
                st.focus ? 'Exit focus' : 'Focus mode',
              ),
            ),
          ),
          h(
            'footer',
            { className: 'footer' },
            'Approve and Later only change this screen. Nothing is sent. Real decisions still happen in chat.',
          ),
        ].filter(Boolean),
      );
      startUsageCountdown();
    }
    draw();
    hud.replaceChildren(
      h('div', { className: 'scan' }),
      h(
        'div',
        { className: 'particles' },
        PARTICLES.map(([t, l, d, s]) =>
          h('span', {
            className: 'particle',
            style: {
              top: t + '%',
              left: l + '%',
              width: s + 'px',
              height: s + 'px',
              animationDelay: d + 's',
            },
          }),
        ),
      ),
      body,
    );
    root.replaceChildren(hud);
    setTimeout(() => {
      hud.classList.replace('is-booting', 'is-booted');
    }, 1600);
  }

  async function lock() {
    stopUsageCountdown();
    sessionKey = null;
    current = null;
    await dropKey();
    try {
      speechSynthesis.cancel();
    } catch {}
    showLock(null);
  }

  async function load(quiet) {
    let env;
    try {
      env = await fetchEnv();
    } catch {
      if (!quiet)
        root.replaceChildren(
          h(
            'div',
            { className: 'lock' },
            h('div', {}, 'Could not load. Check the connection and reopen.'),
          ),
        );
      return;
    }
    const key = sessionKey || (keyBlocked ? null : await getKey());
    if (!key) return showLock(env);
    try {
      const data = await decrypt(key, env);
      sessionKey = key;
      if (!current || data.stamp !== current.stamp) render(data, env);
    } catch {
      await dropKey();
      await dropDataCache();
      sessionKey = null;
      current = null;
      showLock(env, 'The data was re-keyed. Enter the passphrase again.');
    }
  }
  function refresh() {
    current = null;
    load();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sessionKey) load(true);
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  load();
})();
