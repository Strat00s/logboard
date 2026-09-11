'use strict';
/* logboard UI — no build step, no framework. Talks to /api/*. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid) n.append(kid.nodeType ? kid : String(kid));
  return n;
};

const LS = {
  get token() { return localStorage.getItem('lb.token') || ''; },
  set token(v) { localStorage.setItem('lb.token', v || ''); },
  // 0 is a real value here: it means "do not refresh on a timer"
  get interval() { const v = localStorage.getItem('lb.interval'); return v === null ? 15 : Number(v); },
  set interval(v) { localStorage.setItem('lb.interval', String(v)); },
  // null until the user chooses, which means "follow the operating system"
  get theme() { return localStorage.getItem('lb.theme'); },
  set theme(v) { localStorage.setItem('lb.theme', v || ''); },
  // markdown rendering of message bodies, off until the reader turns it on
  get md() { return localStorage.getItem('lb.md') === '1'; },
  set md(v) { localStorage.setItem('lb.md', v ? '1' : '0'); },
  // Read state is per browser: one anonymous id per browser profile, no accounts.
  get reader() {
    let v = localStorage.getItem('lb.reader');
    if (!v) {
      v = (crypto.randomUUID ? crypto.randomUUID() : `r${Date.now()}${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('lb.reader', v);
    }
    return v;
  },
};

const S = {
  channels: [],
  tags: [],
  counts: {},
  scope: { kind: 'all', channelId: null, threadId: null },
  f: { q: '', mode: 'text', cs: false, tags: [], tagMatch: 'all', from: '', to: '', sort: 'desc', limit: 100, offset: 0 },
  total: 0,
  messages: [],
  sel: new Set(),
  expanded: new Set(JSON.parse(localStorage.getItem('lb.expanded') || '[]')),
  // message ids the reader has expanded — kept in localStorage so a card keeps
  // its shape across manual and automatic reloads; truncated messages also
  // cache their fetched full body in memory and refetch it on reload
  msgExpanded: new Set(JSON.parse(localStorage.getItem('lb.msgExpand') || '[]')),
  fullBody: new Map(),
  timer: null,
  // ids that arrived while this thread has been open; cleared when you leave it
  live: new Set(),
  seenThread: null,
  mdOverride: new Map(),
  retentionDays: null,
};

// --------------------------------------------------------------------- helpers

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');

function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function fmtTs(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtAge(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 36e5);
  return d > 0 ? `${d}d ${h}h left` : `${h}h left`;
}

const toLocal = (iso) => {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -------------------------------------------------------------------- API glue

async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (LS.token) headers['x-post-token'] = LS.token;
  headers['x-reader'] = LS.reader;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await res.json(); } catch { throw new Error(`${res.status} ${res.statusText} — not JSON`); }
  if (!res.ok) {
    if (res.status === 401) openSettings('server wants a token — set it in settings');
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

// ------------------------------------------------------------------ read state
// Opening a thread marks it read once you leave it: that is the "seen" event.
// While you stay, messages that arrive are flagged as new but stay unread, so
// refreshing the page still tells you something landed.

async function markRead(threadId) {
  try {
    await api(`/api/reads/${threadId}`, { method: 'POST', body: {} });
    return true;
  } catch {
    return false; // read state is a nicety — never block the board on it
  }
}

async function markAllRead(channelId = null) {
  try {
    const d = await api('/api/reads', { method: 'POST', body: channelId ? { channel_id: channelId } : {} });
    setStatus(`${fmtNum(d.marked)} message(s) marked read`);
  } catch (err) {
    setStatus(err.message, true);
  }
  await reload({ keepScroll: true });
}

async function leaveThread() {
  const threadId = S.scope.kind === 'thread' ? S.scope.threadId : null;
  if (!threadId) return;
  S.live.clear();
  S.seenThread = null;
  if (await markRead(threadId)) await loadTree(); // badges and title follow immediately
}

// Title badge: how much is waiting, even when the tab is in the background.
function renderTitle() {
  const unread = Number(S.counts?.unread || 0);
  document.title = unread ? `(${fmtNum(unread)}) logboard` : 'logboard';
}

// --------------------------------------------------------------------- loading

async function loadTree() {
  const d = await api('/api/tree');
  S.channels = d.channels;
  S.counts = d.counts;
  renderSidebar();
  renderCrumbs();
  renderTitle();
}

async function loadTags() {
  const d = await api('/api/tags');
  S.tags = d.tags;
  renderTagFilterPanel();
}

async function loadMessages({ keepScroll = false } = {}) {
  const scroll = $('#main').scrollTop; // #main scrolls; the window itself never does
  const query = {
    sort: S.f.sort,
    limit: S.f.limit,
    offset: S.f.offset,
    tag_match: S.f.tagMatch,
  };
  if (S.f.q) { query.q = S.f.q; query.mode = S.f.mode; if (S.f.cs) query.cs = '1'; }
  if (S.f.tags.length) query.tags = S.f.tags.join(',');
  if (S.f.from) query.from = S.f.from;
  if (S.f.to) query.to = S.f.to;
  if (S.scope.kind === 'thread') query.thread = S.scope.threadId;
  else if (S.scope.kind === 'channel') query.channel = S.scope.channelId;

  let d;
  try {
    d = await api('/api/messages', { query });
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  if ($('#status').classList.contains('error')) setStatus('');
  // Flag ids that landed while this thread view is open: they keep the NEW marker
  // until you click away, which is also when the thread becomes read.
  const threadId = S.scope.kind === 'thread' ? S.scope.threadId : null;
  if (threadId !== S.seenThread) {
    S.seenThread = threadId;
    S.live = new Set();
  } else if (threadId) {
    const known = new Set(S.messages.map((x) => x.id));
    for (const m of d.messages) if (!known.has(m.id)) S.live.add(m.id);
  }
  S.total = d.total;
  S.messages = d.messages;
  await refillFullBodies();
  renderMessages();
  renderCrumbs();
  // restore after the new list exists, otherwise the offset is clamped to old content
  $('#main').scrollTop = keepScroll ? scroll : 0;
}

async function reload({ keepScroll = false } = {}) {
  await Promise.all([loadTree(), loadTags(), loadMessages({ keepScroll })]);
}

// ------------------------------------------------------------------- rendering

let statusTimer = null;

// Confirmation lines fade away on their own; errors stay until the next result.
function setStatus(msg, isError = false, ttl = 6000) {
  const n = $('#status');
  n.textContent = msg || '';
  n.classList.toggle('error', !!isError);
  clearTimeout(statusTimer);
  if (msg && !isError) statusTimer = setTimeout(() => { if (n.textContent === msg) n.textContent = ''; }, ttl);
}

function findChannel(id) { return S.channels.find((c) => c.id === Number(id)); }
function findThread(id) {
  for (const c of S.channels) {
    const t = c.threads.find((t) => t.id === Number(id));
    if (t) return { channel: c, thread: t };
  }
  return null;
}

function scopeLabel() {
  if (S.scope.kind === 'thread') {
    const hit = findThread(S.scope.threadId);
    return hit ? `${hit.channel.name} » ${hit.thread.name}` : 'thread';
  }
  if (S.scope.kind === 'channel') return `${findChannel(S.scope.channelId)?.name || 'channel'} (whole channel)`;
  return 'all messages';
}

function scopeQuery() {
  if (S.scope.kind === 'thread') return `thread=${S.scope.threadId}`;
  if (S.scope.kind === 'channel') return `channel=${S.scope.channelId}`;
  return '';
}

function renderSidebar() {
  $('#health').textContent =
    `${fmtNum(S.counts.messages)} messages · ${fmtNum(S.counts.channels)} channels · ` +
    `${fmtNum(S.counts.threads)} threads · ${fmtNum(S.counts.tags)} tags · ` +
    `${fmtBytes(S.counts.bytes)} stored · ${fmtBytes(S.counts.db_bytes)} db`;
  $('#health').title =
    `${fmtBytes(S.counts.bytes)} of message bodies; the SQLite file (with its WAL) is ` +
    `${fmtBytes(S.counts.db_bytes)} on the server`;
  $('#total-count').textContent = `${fmtNum(S.counts.messages)}`;

  // pending / unassigned
  const pendingChannels = S.channels.filter((c) => c.pending);
  const pendingThreads = [];
  for (const c of S.channels) {
    if (c.pending) continue;
    for (const t of c.threads) if (t.pending) pendingThreads.push({ channel: c, thread: t });
  }
  const pendingList = $('#pending-list');
  pendingList.textContent = '';
  const nPending = pendingChannels.length + pendingThreads.length;
  $('#pending-panel').classList.toggle('hidden', nPending === 0);
  $('#pending-count').textContent = nPending ? String(nPending) : '';
  $('#pending-hint').textContent = nPending
    ? `auto-created by scripts; deleted after ${S.pendingDays ?? 10} days unless adopted`
    : '';

  for (const c of pendingChannels) {
    pendingList.append(pendingChannelNode(c));
    const sub = el('ul', { class: 'threads' });
    for (const t of c.threads) if (t.pending) sub.append(pendingThreadNode(c, t, true));
    pendingList.append(sub);
  }
  for (const { channel, thread } of pendingThreads) {
    pendingList.append(pendingThreadNode(channel, thread, false));
  }

  // real channels
  const list = $('#channel-list');
  list.textContent = '';
  const active = S.channels.filter((c) => !c.pending);
  if (!active.length) list.append(el('li', { class: 'hint', text: 'no channels yet — post a message or click "+ channel"' }));
  for (const c of active) {
    list.append(channelNode(c));
    const expanded = S.expanded.has(c.id) || S.scope.kind === 'thread' && S.scope.channelId === c.id;
    if (!expanded) continue;
    const sub = el('ul', { class: 'threads' });
    const real = c.threads.filter((t) => !t.pending);
    for (const t of real) sub.append(threadNode(c, t));
    sub.append(el('li', { class: 'node', onclick: () => createThread(c) }, el('span', { class: 'name', text: '+ thread' })));
    list.append(sub);
  }
  enableChannelDrag();
}

function pendingChannelNode(c) {
  const active = S.scope.kind === 'channel' && S.scope.channelId === c.id;
  const node = el('li', {
    class: `node pending-item${active ? ' active' : ''}`,
    onclick: () => gotoScope({ kind: 'channel', channelId: c.id }),
  },
    el('span', { class: 'name', text: `⚠ ${c.name}` }),
    el('span', { class: 'meta', text: `${fmtNum(c.messages)} msg · ${fmtLeft(c.expires_at)}` }),
    el('span', { class: 'row-actions' },
      el('button', { class: 'icon-btn', title: 'adopt as a real channel', onclick: async (e) => { e.stopPropagation(); await act(`/api/channels/${c.id}/adopt`, 'POST'); } }, '✔'),
      el('button', { class: 'icon-btn danger', title: 'discard channel and its messages', onclick: async (e) => { e.stopPropagation(); if (confirm(`Discard pending channel "${c.name}" and its ${c.messages} message(s)?`)) await act(`/api/channels/${c.id}`, 'DELETE'); } }, '✖'),
    ));
  return node;
}

function pendingThreadNode(channel, t, nested) {
  const active = S.scope.kind === 'thread' && S.scope.threadId === t.id;
  return el('li', {
    class: `node pending-item${nested ? '' : ''}${active ? ' active' : ''}`,
    style: nested ? 'margin-left:14px' : '',
    onclick: () => gotoScope({ kind: 'thread', channelId: channel.id, threadId: t.id }),
  },
    el('span', { class: 'name', text: `⚠ ${nested ? '' : `${channel.name} » `}${t.name}` }),
    el('span', { class: 'meta', text: `${fmtNum(t.messages)} · ${fmtLeft(t.expires_at)}` }),
    el('span', { class: 'row-actions' },
      el('button', { class: 'icon-btn', title: 'adopt as a real thread', onclick: async (e) => { e.stopPropagation(); await act(`/api/threads/${t.id}/adopt`, 'POST'); } }, '✔'),
      el('button', { class: 'icon-btn danger', title: 'discard thread and its messages', onclick: async (e) => { e.stopPropagation(); if (confirm(`Discard pending thread "${t.name}" and its ${t.messages} message(s)?`)) await act(`/api/threads/${t.id}`, 'DELETE'); } }, '✖'),
    ));
}

function channelNode(c) {
  const active = S.scope.kind === 'channel' && S.scope.channelId === c.id;
  const expanded = S.expanded.has(c.id) || (S.scope.kind === 'thread' && S.scope.channelId === c.id);
  const node = el('li', {
    class: `node chan-row${active ? ' active' : ''}${c.unread ? ' has-unread' : ''}`,
    draggable: 'true',
    'data-id': c.id,
    'data-kind': 'channel',
    'data-channel-name': c.name,
    onclick: () => gotoScope({ kind: 'channel', channelId: c.id }),
  },
    el('span', {
      class: 'tw', text: expanded ? '▾' : '▸', title: 'show/hide threads',
      onclick: (e) => { e.stopPropagation(); if (S.expanded.has(c.id)) S.expanded.delete(c.id); else S.expanded.add(c.id); saveExpanded(); renderSidebar(); },
    }),
    el('span', { class: 'grip', text: '⋮⋮', title: 'drag to reorder' }),
    el('span', { class: 'name', text: c.name }),
    el('span', { class: 'meta', text: `${fmtNum(c.messages)} · ${fmtAge(c.last_ts)}` }),
    c.unread ? el('span', { class: 'unread-badge', title: `${fmtNum(c.unread)} unread in this channel`, text: fmtNum(c.unread) }) : null,
    el('span', { class: 'row-actions' },
      el('button', { class: 'icon-btn', title: 'add thread', onclick: (e) => { e.stopPropagation(); createThread(c); } }, '＋'),
      el('button', { class: 'icon-btn', title: 'rename channel', onclick: (e) => { e.stopPropagation(); renameChannel(c); } }, '✎'),
      el('button', { class: 'icon-btn danger', title: 'delete channel', onclick: (e) => { e.stopPropagation(); deleteChannel(c); } }, '🗑'),
    ));
  node.addEventListener('dragstart', onDragStart);
  return node;
}

function threadNode(channel, t) {
  const active = S.scope.kind === 'thread' && S.scope.threadId === t.id;
  const node = el('li', {
    class: `node${active ? ' active' : ''}${t.unread ? ' has-unread' : ''}`,
    draggable: 'true',
    'data-id': t.id,
    'data-kind': 'thread',
    'data-channel': channel.id,
    'data-thread-name': t.name,
    title: `${channel.name} » ${t.name}`,
    onclick: () => gotoScope({ kind: 'thread', channelId: channel.id, threadId: t.id }),
  },
    el('span', { class: 'grip', text: '⋮⋮', title: 'drag to reorder' }),
    el('span', { class: 'name', text: t.name }),
    el('span', { class: 'meta', text: fmtNum(t.messages) }),
    t.unread ? el('span', { class: 'unread-badge', title: `${fmtNum(t.unread)} unread in this thread`, text: fmtNum(t.unread) }) : null,
    el('span', { class: 'row-actions' },
      el('button', { class: 'icon-btn', title: 'rename thread', onclick: (e) => { e.stopPropagation(); renameThread(channel, t); } }, '✎'),
      el('button', { class: 'icon-btn', title: 'move thread to another channel', onclick: (e) => { e.stopPropagation(); moveThread(channel, t); } }, '⇄'),
      el('button', { class: 'icon-btn danger', title: 'delete thread', onclick: (e) => { e.stopPropagation(); deleteThread(channel, t); } }, '🗑'),
    ));
  node.addEventListener('dragstart', onDragStart);
  node.addEventListener('dragend', onDragEnd);
  return node;
}

function saveExpanded() {
  localStorage.setItem('lb.expanded', JSON.stringify([...S.expanded]));
}

function saveMsgExpanded() {
  localStorage.setItem('lb.msgExpand', JSON.stringify([...S.msgExpanded]));
}

// Fetch and remember one message's full body (only once — the cache also backs
// the compact view after collapsing, so no refetch on re-expand).
async function loadFullText(id) {
  if (!S.fullBody.has(id)) {
    const d = await api(`/api/messages/${id}`);
    S.fullBody.set(id, d.message.body);
  }
  return S.fullBody.get(id);
}

// On reload the list only carries truncated bodies, so re-fetch the full text of
// every expanded message that is on this page before drawing it.
async function refillFullBodies() {
  const need = S.messages.filter((m) => m.truncated && S.msgExpanded.has(m.id) && !S.fullBody.has(m.id));
  await Promise.all(need.map((m) => loadFullText(m.id).catch(() => {
    S.msgExpanded.delete(m.id); // target is gone — stop retrying it
    saveMsgExpanded();
  })));
}

function renderCrumbs() {
  const crumbs = $('#crumbs');
  crumbs.textContent = '';
  const title = el('h2', { text: scopeLabel() });
  crumbs.append(title);
  const range = S.total ? `${S.f.offset + 1}–${Math.min(S.f.offset + S.messages.length, S.total)}` : 'none';
  const bits = [`${fmtNum(S.total)} match${S.total === 1 ? '' : 'es'} (${range})`];
  if (S.f.q) bits.push(`${S.f.mode}${S.f.cs ? ' · case sensitive' : ''}: /${S.f.q}/`);
  if (S.f.tags.length) bits.push(`tags(${S.f.tagMatch === 'any' ? 'OR' : 'AND'}): ${S.f.tags.join(', ')}`);
  if (S.f.from) bits.push(`from ${fmtTs(S.f.from)}`);
  if (S.f.to) bits.push(`to ${fmtTs(S.f.to)}`);
  crumbs.append(el('span', { class: 'sub', text: bits.join('  ·  ') }));

  if (S.scope.kind !== 'all') {
    crumbs.append(el('button', { class: 'btn', onclick: () => gotoScope({ kind: 'all' }) }, '✕ scope'));
  }
  if (S.scope.kind === 'thread') {
    crumbs.append(el('button', { class: 'btn primary', onclick: toggleComposer }, '＋ message'));
  }
  // offer to clear unread for exactly what is on screen
  const hereUnread = S.scope.kind === 'all'
    ? Number(S.counts.unread || 0)
    : (S.scope.kind === 'thread'
      ? findThread(S.scope.threadId)?.thread.unread ?? 0
      : findChannel(S.scope.channelId)?.unread ?? 0);
  if (hereUnread) {
    crumbs.append(el('button', {
      class: 'btn',
      title: 'mark these messages read',
      onclick: async () => {
        if (S.scope.kind === 'thread') {
          await markRead(S.scope.threadId);
          await loadTree();
        } else if (S.scope.kind === 'channel') {
          await markAllRead(S.scope.channelId);
        } else {
          await markAllRead();
        }
      },
    }, `mark ${fmtNum(hereUnread)} read`));
  }
  $('#tags-label').textContent = S.f.tags.length ? S.f.tags.join(', ') : 'none';
  // the filter controls show the state they will switch to, so the chrome can
  // never disagree with the query that actually ran
  const tm = $('#btn-tag-match');
  tm.textContent = S.f.tagMatch === 'any' ? 'ANY' : 'ALL';
  tm.classList.toggle('on', S.f.tagMatch === 'any');
  $('#btn-tags').classList.toggle('on', S.f.tags.length > 0);
  const curl = $('#curl-example');
  if (curl) {
    const t = S.scope.kind === 'thread' ? findThread(S.scope.threadId) : null;
    const ch = S.scope.kind === 'all' ? 'PC1' : findChannel(S.scope.channelId)?.name || t?.channel.name || 'PC1';
    const th = t ? t.thread.name : 'drive health';
    curl.textContent =
      `curl -X POST ${location.origin}/api/post \\\n` +
      `  -H 'content-type: application/json' \\\n` +
      `  -d '{"channel":${JSON.stringify(ch)},"thread":${JSON.stringify(th)},\n` +
      `       "tags":["smart"],"text":"put the disk number here"}'`;
  }
  renderPager();
}

function renderTagFilterPanel() {
  const panel = $('#tag-filter-panel');
  panel.textContent = '';
  if (!S.tags.length) {
    panel.append(el('span', { class: 'hint', text: 'no tags yet — tags appear as soon as a message carries one' }));
    return;
  }
  for (const t of S.tags) {
    const on = S.f.tags.includes(t.name);
    panel.append(el('button', {
      class: `tag-chip${on ? ' on' : ''}`,
      onclick: () => {
        if (on) S.f.tags = S.f.tags.filter((x) => x !== t.name);
        else S.f.tags.push(t.name);
        S.f.offset = 0;
        loadTags();
        loadMessages();
      },
    }, `${t.name} `, el('span', { class: 'n', text: fmtNum(t.messages) })));
  }
}

function highlightTarget() {
  if (!S.f.q) return null;
  const src = S.f.mode === 'regex' ? S.f.q : escRe(S.f.q);
  try { return new RegExp(src, S.f.cs ? 'g' : 'gi'); } catch { return null; }
}

function highlight(text, re) {
  const frag = document.createDocumentFragment();
  if (!re) { frag.append(text); return frag; }
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[0]) frag.append(el('mark', { text: m[0] }));
    last = m.index + m[0].length;
    if (m[0] === '') re.lastIndex += 1; // zero-width match: advance manually
  }
  frag.append(text.slice(last));
  return frag;
}

// Effective markdown mode for one message: its own toggle wins, else the
// global one from localStorage.
const mdOn = (id) => S.mdOverride.has(id) ? S.mdOverride.get(id) : LS.md;

// Put a message body into its element, rendered or raw. A missing or broken
// markdown library silently degrades to plain text.
function fillBody(node, text, re, md) {
  node.textContent = '';
  const frag = md && window.MVmd ? window.MVmd.render(text) : null;
  if (frag) { window.MVmd.highlightIn(frag, re); node.append(frag); }
  else node.append(highlight(text, re));
}

// Rebuild one card in place, e.g. after flipping its markdown toggle.
function rerenderCard(id) {
  const m = S.messages.find((x) => x.id === id);
  const old = document.querySelector(`#messages .msg[data-id="${id}"]`);
  if (m && old) old.replaceWith(messageCard(m, highlightTarget()));
}

function renderMdControl() {
  const b = $('#btn-md');
  b.classList.toggle('on', LS.md);
  b.textContent = LS.md ? 'md ✓' : 'md';
  b.title = LS.md
    ? 'messages render as markdown — click to go back to raw text'
    : 'messages show raw text — click to render them as markdown';
}

function renderMessages() {
  const list = $('#messages');
  list.textContent = '';
  const re = highlightTarget();
  if (!S.messages.length) {
    list.append(el('div', { class: 'hint', text: S.total === 0 ? 'nothing matched' : 'no messages on this page' }));
    renderBulk();
    return;
  }
  for (const m of S.messages) list.append(messageCard(m, re));
  renderBulk();
}

function messageCard(m, re) {
  const classes = ['msg'];
  if (S.sel.has(m.id)) classes.push('selected');
  // unread: not yet seen in its thread; live: arrived while this thread is open
  if (m.unread) classes.push('unread');
  if (S.live.has(m.id)) classes.push('live');
  const card = el('div', { class: classes.join(' '), 'data-id': m.id });

  const cb = el('input', { type: 'checkbox', title: 'select for bulk delete' });
  cb.checked = S.sel.has(m.id);
  cb.addEventListener('change', () => {
    if (cb.checked) S.sel.add(m.id); else S.sel.delete(m.id);
    card.classList.toggle('selected', cb.checked);
    renderBulk();
  });

  const md = mdOn(m.id);

  const head = el('div', { class: 'msg-head' },
    cb,
    el('span', {
      class: 'unread-dot',
      title: m.unread ? 'unread — open the thread, then click away to mark it read' : '',
      text: m.unread ? '●' : '',
    }),
    el('span', { class: 'ts', title: m.ts, text: fmtTs(m.ts) }),
    el('span', { class: 'id', text: `#${m.id}` }),
    el('span', { class: 'where' },
      el('b', { text: m.channel }), ' / ', el('b', { text: m.thread }),
      m.thread_pending || m.channel_pending ? el('span', { class: 'src', text: ' (unassigned)' }) : null),
    el('span', { class: 'len', title: `${fmtBytes(m.bytes)} on disk`, text: `${fmtNum(m.chars)} chars · ${fmtBytes(m.bytes)}` }),
    m.source ? el('span', { class: 'src', text: `via ${m.source}` }) : null,
    S.live.has(m.id) ? el('span', { class: 'new-flag', text: 'NEW' }) : null,
    el('span', { class: 'spacer' }),
    el('button', {
      class: `btn small${md ? ' on' : ''}`,
      title: md ? 'show this message as raw text' : 'render this message as markdown',
      onclick: () => { S.mdOverride.set(m.id, !md); rerenderCard(m.id); },
    }, 'md'),
    el('button', {
      class: 'btn small',
      onclick: async () => { if (confirm(`Delete message #${m.id}?`)) await act(`/api/messages/${m.id}`, 'DELETE'); },
    }, 'delete'),
  );

  // One button does both jobs: it opens a clamped card all the way (loading the
  // full text first, once, for a message the list truncated) and collapses it
  // back to the compact scroll box afterwards. Which cards are open lives in
  // localStorage, so the shape survives manual and automatic reloads; a loaded
  // full body is refetched on reload for cards that are still open.
  const hasFull = m.truncated && S.fullBody.has(m.id);
  const expanded = S.msgExpanded.has(m.id) && (!m.truncated || hasFull);
  const shown = hasFull ? S.fullBody.get(m.id) : m.body;
  const clamp = m.truncated || shown.split('\n').length > 12 || m.chars > 1400;
  const body = el(md ? 'div' : 'pre', { class: `msg-body${md ? ' md' : ''}${expanded ? ' full' : clamp ? ' collapsed' : ''}` });
  fillBody(body, shown, re, md);
  const foot = el('div', { class: 'msg-foot' }, tagWidgets(m));

  card.append(head, body);
  if (clamp) {
    card.append(el('div', { class: 'msg-foot' },
      el('button', {
        class: 'expand',
        text: expanded ? '▾ collapse' : m.truncated ? 'message too long for the list — expand' : '▸ expand',
        onclick: async (e) => {
          const btn = e.target;
          if (btn.disabled) return;
          if (S.msgExpanded.has(m.id)) S.msgExpanded.delete(m.id);
          else {
            btn.disabled = true; // opening a truncated card needs the full body first
            if (m.truncated && !hasFull) {
              try { await loadFullText(m.id); } catch (err) { btn.disabled = false; setStatus(err.message, true); return; }
            }
            S.msgExpanded.add(m.id);
          }
          saveMsgExpanded();
          rerenderCard(m.id);
        },
      })));
  }
  card.append(foot);
  return card;
}

function tagWidgets(m) {
  const out = [];
  for (const name of m.tags) {
    out.push(el('button', {
      class: 'mtag',
      title: `filter messages by "${name}"`,
      onclick: () => { if (!S.f.tags.includes(name)) { S.f.tags.push(name); S.f.offset = 0; loadTags(); loadMessages(); } },
    }, name, el('span', {
      class: 'x', title: `remove tag from this message`,
      onclick: async (e) => { e.stopPropagation(); await act(`/api/messages/${m.id}`, 'PATCH', { remove_tags: [name] }); },
    }, '×')));
  }
  const addBtn = el('button', { class: 'add-tag', title: 'add tag', onclick: () => openTagInput() }, '+ tag');
  out.push(addBtn);

  function openTagInput() {
    const input = el('input', { class: 'add-tag-input', placeholder: 'tag, Enter to add', spellcheck: 'false' });
    const restore = () => { if (input.isConnected) input.replaceWith(addBtn); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = input.value.trim();
        if (v) act(`/api/messages/${m.id}`, 'PATCH', { add_tags: [v] });
        else restore();
      }
      if (e.key === 'Escape') restore();
    });
    input.addEventListener('blur', () => setTimeout(restore, 150));
    addBtn.replaceWith(input);
    input.focus();
  }
  return out;
}

function renderPager() {
  const pager = $('#pager');
  pager.textContent = '';
  const pages = Math.ceil(S.total / S.f.limit);
  const page = Math.floor(S.f.offset / S.f.limit) + 1;
  if (S.total <= S.f.limit) return;
  pager.append(
    el('button', { class: 'btn', disabled: page <= 1, onclick: () => { S.f.offset -= S.f.limit; loadMessages(); } }, '← prev'),
    el('span', { text: `page ${page} of ${pages}` }),
    el('button', { class: 'btn', disabled: page >= pages, onclick: () => { S.f.offset += S.f.limit; loadMessages(); } }, 'next →'),
  );
}

function renderBulk() {
  const bar = $('#bulk-bar');
  bar.classList.toggle('hidden', S.sel.size === 0);
  $('#bulk-label').textContent = `${S.sel.size} message(s) selected`;
}

// ---------------------------------------------------------------- mutations

async function act(path, method, body) {
  try {
    await api(path, { method, body });
  } catch (err) {
    setStatus(err.message, true);
    return null;
  }
  await reload({ keepScroll: true });
  // drop selection entries that no longer exist on screen
  for (const id of [...S.sel]) if (!S.messages.some((m) => m.id === id)) S.sel.delete(id);
  renderBulk();
  return true;
}

const askName = (label, value = '') => {
  const v = prompt(label, value);
  return v === null ? null : v.trim();
};

async function createChannel() {
  const name = askName('new channel name');
  if (!name) return;
  await act('/api/channels', 'POST', { name });
}

async function renameChannel(c) {
  const name = askName(`rename channel "${c.name}"`, c.name);
  if (!name || name === c.name) return;
  await act(`/api/channels/${c.id}`, 'PATCH', { name });
}

async function deleteChannel(c) {
  if (!confirm(`Delete channel "${c.name}" with all ${fmtNum(c.messages)} message(s)?`)) return;
  if (S.scope.channelId === c.id) gotoScope({ kind: 'all' }, true);
  await act(`/api/channels/${c.id}`, 'DELETE');
}

async function createThread(c) {
  const name = askName(`new thread in "${c.name}"`);
  if (!name) return;
  S.expanded.add(c.id);
  saveExpanded();
  await act('/api/threads', 'POST', { channel_id: c.id, name });
}

async function renameThread(channel, t) {
  const name = askName(`rename thread "${t.name}"`, t.name);
  if (!name || name === t.name) return;
  await act(`/api/threads/${t.id}`, 'PATCH', { name });
}

async function moveThread(channel, t) {
  const targets = S.channels.filter((c) => !c.pending && c.id !== channel.id);
  if (!targets.length) return setStatus('no other channel to move to', true);
  const name = askName(`move thread "${t.name}" to channel (existing names:\n${targets.map((c) => c.name).join(', ')})`, targets[0].name);
  if (!name) return;
  const target = targets.find((c) => c.name === name);
  if (!target) return setStatus(`no channel named "${name}"`, true);
  await act(`/api/threads/${t.id}`, 'PATCH', { channel_id: target.id });
}

async function deleteThread(channel, t) {
  if (!confirm(`Delete thread "${t.name}" with all ${fmtNum(t.messages)} message(s)?`)) return;
  if (S.scope.threadId === t.id) gotoScope({ kind: 'channel', channelId: channel.id }, true);
  await act(`/api/threads/${t.id}`, 'DELETE');
}

async function deleteSelected() {
  if (!S.sel.size) return;
  if (!confirm(`Delete ${S.sel.size} selected message(s)?`)) return;
  const ids = [...S.sel];
  S.sel.clear();
  try {
    const d = await api('/api/messages/delete', { method: 'POST', body: { ids } });
    setStatus(`deleted ${d.deleted} message(s)`);
  } catch (err) {
    setStatus(err.message, true);
  }
  await reload({ keepScroll: true });
}

// ------------------------------------------------------------------ composer

let composerOpen = false;
function toggleComposer() {
  composerOpen = !composerOpen;
  $('#composer').classList.toggle('hidden', !composerOpen);
  if (composerOpen) $('#compose-text').focus();
}

async function sendCompose() {
  const text = $('#compose-text').value;
  if (!text.trim()) return setStatus('nothing to post', true);
  const hit = findThread(S.scope.threadId);
  if (!hit) return setStatus('pick a thread first', true);
  const tags = $('#compose-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await fetch('/api/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(LS.token ? { 'x-post-token': LS.token } : {}) },
    body: JSON.stringify({ channel: hit.channel.name, thread: hit.thread.name, text, tags }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return setStatus(data.error || 'post failed', true);
  $('#compose-text').value = '';
  $('#compose-tags').value = '';
  setStatus(`posted #${data.message.id} · ${fmtNum(data.message.chars)} chars`);
  await loadMessages({ keepScroll: true });
  await loadTree();
}

// ---------------------------------------------------------------- drag & drop

let dragInfo = null;

function onDragStart(e) {
  const node = e.currentTarget;
  dragInfo = { kind: node.dataset.kind, id: Number(node.dataset.id), channel: Number(node.dataset.channel) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', node.dataset.id);
}

function onDragEnd() {
  dragInfo = null;
  document.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

function clearDropMarks() {
  document.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

function enableChannelDrag() {
  document.querySelectorAll('#channel-list .node[data-kind]').forEach((node) => {
    node.addEventListener('dragover', (e) => {
      if (!dragInfo) return;
      const sameKind = node.dataset.kind === dragInfo.kind;
      const sameGroup =
        dragInfo.kind === 'channel' || Number(node.dataset.channel) === dragInfo.channel;
      if (!sameKind || !sameGroup || Number(node.dataset.id) === dragInfo.id) return;
      e.preventDefault();
      clearDropMarks();
      const r = node.getBoundingClientRect();
      node.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
    node.addEventListener('drop', async (e) => {
      if (!dragInfo) return;
      e.preventDefault();
      const before = node.classList.contains('drop-before');
      clearDropMarks();
      const targetId = Number(node.dataset.id);
      const { kind, id, channel } = dragInfo;
      dragInfo = null;
      if (kind === 'channel') {
        const ids = S.channels.filter((c) => !c.pending).map((c) => c.id).filter((x) => x !== id);
        const at = ids.indexOf(targetId);
        ids.splice(before ? at : at + 1, 0, id);
        await act('/api/channels/reorder', 'POST', { ids });
      } else {
        const ch = findChannel(channel);
        if (!ch) return;
        const ids = ch.threads.filter((t) => !t.pending).map((t) => t.id).filter((x) => x !== id);
        const at = ids.indexOf(targetId);
        ids.splice(before ? at : at + 1, 0, id);
        await act('/api/threads/reorder', 'POST', { channel_id: ch.id, ids });
      }
    });
  });
}

// ---------------------------------------------------------------------- scope

async function gotoScope(scope, skipLoad = false) {
  // clicking away from a thread is what counts as having read it
  if (scope.kind !== 'thread' || scope.threadId !== S.scope.threadId) await leaveThread();
  S.scope = { kind: scope.kind, channelId: scope.channelId ?? null, threadId: scope.threadId ?? null };
  S.f.offset = 0;
  S.sel.clear();
  const hash =
    scope.kind === 'thread' ? `#/thread/${scope.threadId}`
      : scope.kind === 'channel' ? `#/channel/${scope.channelId}`
        : '#/all';
  if (location.hash !== hash) {
    location.hash = hash;
    // hashchange handler does the loading
    setTimeout(() => { if (!skipLoad) loadMessages(); }, 0);
  } else if (!skipLoad) {
    loadMessages();
  }
  renderSidebar();
}

function readHash() {
  const m = /^#\/(thread|channel)\/(\d+)$/.exec(location.hash || '');
  if (m) {
    const id = Number(m[2]);
    if (m[1] === 'thread') {
      const hit = findThread(id);
      return { kind: 'thread', channelId: hit ? hit.channel.id : null, threadId: id };
    }
    return { kind: 'channel', channelId: id, threadId: null };
  }
  return { kind: 'all', channelId: null, threadId: null };
}

// --------------------------------------------------------------------- events

function bindUi() {
  $('#btn-new-channel').addEventListener('click', createChannel);
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#scope-all').addEventListener('click', (e) => { e.preventDefault(); gotoScope({ kind: 'all' }); });
  $('#btn-refresh').addEventListener('click', () => reload());

  const search = $('#search');
  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { S.f.q = search.value; S.f.offset = 0; loadMessages(); }, 300);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(debounce); S.f.q = search.value; S.f.offset = 0; loadMessages(); }
  });
  $('#btn-clear-search').addEventListener('click', () => {
    search.value = ''; S.f.q = ''; S.f.offset = 0; loadMessages();
  });
  $('#mode-text').addEventListener('click', () => setSearchMode('text'));
  $('#mode-regex').addEventListener('click', () => setSearchMode('regex'));
  $('#mode-cs').addEventListener('click', () => {
    S.f.cs = !S.f.cs;
    $('#mode-cs').classList.toggle('on', S.f.cs);
    S.f.offset = 0;
    loadMessages();
  });

  $('#btn-tags').addEventListener('click', () => {
    const panel = $('#tag-filter-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadTags(); // counts must not be stale on open
  });
  $('#btn-tag-match').addEventListener('click', () => {
    S.f.tagMatch = S.f.tagMatch === 'any' ? 'all' : 'any';
    S.f.offset = 0;
    loadMessages();
  });
  $('#from').addEventListener('change', () => { S.f.from = $('#from').value; S.f.offset = 0; loadMessages(); });
  $('#to').addEventListener('change', () => { S.f.to = $('#to').value; S.f.offset = 0; loadMessages(); });
  $('#preset').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) { S.f.from = ''; $('#from').value = ''; }
    else {
      const mult = { h: 36e5, d: 864e5, w: 6048e5 };
      const amount = Number(v.slice(1, -1)); // "-30d" → 30
      S.f.from = toLocal(new Date(Date.now() - amount * mult[v.slice(-1)]));
      $('#to').value = '';
      S.f.to = '';
      $('#from').value = S.f.from;
    }
    S.f.offset = 0;
    loadMessages();
  });
  $('#sort').addEventListener('change', (e) => { S.f.sort = e.target.value; S.f.offset = 0; loadMessages(); });
  $('#limit').addEventListener('change', (e) => { S.f.limit = Number(e.target.value); S.f.offset = 0; loadMessages(); });
  $('#interval').addEventListener('change', (e) => {
    LS.interval = Math.max(0, Math.min(Number(e.target.value) || 0, 3600));
    setupTimer();
    renderRefreshControl();
    setStatus(refreshSecs() ? `auto-refresh: every ${fmtSecs(refreshSecs())}` : 'auto-refresh off');
  });
  $('#btn-theme').addEventListener('click', () => applyTheme(theme() === 'light' ? 'dark' : 'light'));
  $('#btn-md').addEventListener('click', () => {
    LS.md = !LS.md;
    S.mdOverride.clear(); // a global flip outranks the per-card choices
    renderMdControl();
    renderMessages();
  });
  // coming back to a tab that has been refreshing (or not) in the background
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && refreshSecs()) refreshAll();
  });
  // follow the operating system until the user picks a side
  const mq = window.matchMedia && matchMedia('(prefers-color-scheme: light)');
  mq?.addEventListener?.('change', (e) => { if (!LS.theme) applyTheme(e.matches ? 'light' : 'dark'); });

  $('#bulk-delete').addEventListener('click', deleteSelected);
  $('#bulk-clear').addEventListener('click', () => { S.sel.clear(); renderMessages(); renderBulk(); });

  $('#compose-send').addEventListener('click', sendCompose);
  $('#compose-cancel').addEventListener('click', () => { composerOpen = false; $('#composer').classList.add('hidden'); });
  $('#compose-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCompose(); }
  });
  $('#compose-text').addEventListener('keydown', (e) => e.stopPropagation());

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) { e.preventDefault(); search.focus(); search.select(); }
    if (e.key === 'r' && !typing) reload();
    if (e.key === 'Escape') $('#tag-filter-panel').classList.add('hidden');
  });

  window.addEventListener('hashchange', async () => {
    const next = readHash();
    if (next.kind !== 'thread' || next.threadId !== S.scope.threadId) await leaveThread();
    S.scope = next;
    S.f.offset = 0;
    S.sel.clear();
    renderSidebar();
    await loadMessages();
    renderCrumbs();
  });
}

function setSearchMode(mode) {
  S.f.mode = mode;
  $('#mode-text').classList.toggle('on', mode === 'text');
  $('#mode-regex').classList.toggle('on', mode === 'regex');
  S.f.offset = 0;
  loadMessages();
}

// The watermark is kept in the browser, so a normal tab close is still a "seen".
window.addEventListener('pagehide', () => {
  if (S.scope.kind !== 'thread') return;
  fetch(`/api/reads/${S.scope.threadId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-reader': LS.reader },
    keepalive: true,
  }).catch(() => {});
});

// ---------------------------------------------------------------- refresh
// One timer drives the whole board. Reloading only the message list would leave
// the sidebar counts, the unread badges and the unassigned panel frozen at the
// moment you last touched them, which is exactly what you notice when a message
// lands in a channel you are not looking at.
async function refreshAll() {
  if (document.hidden || dragInfo) return; // a hidden tab needs no repaints; never fight a drag
  const jobs = [loadMessages({ keepScroll: true }), loadTree()];
  if (!$('#tag-filter-panel').classList.contains('hidden')) jobs.push(loadTags());
  const out = await Promise.allSettled(jobs);
  const failed = out.find((r) => r.status === 'rejected');
  if (failed) setStatus(`refresh failed: ${failed.reason?.message || failed.reason}`, true);
}

function refreshSecs() {
  const v = Number(LS.interval);
  if (!Number.isFinite(v) || v < 0) return 15; // a broken value is not a reason to go silent
  if (v === 0) return 0;
  return Math.min(Math.max(Math.floor(v), 1), 3600); // "off" is exact; anything else is at least a second
}

function setupTimer() {
  clearInterval(S.timer);
  S.timer = null;
  const secs = refreshSecs();
  if (!secs) return;
  S.timer = setInterval(refreshAll, secs * 1000);
}

// the toolbar select and the settings field are two views of one number
function renderRefreshControl() {
  const sel = $('#interval');
  const secs = refreshSecs();
  if (![...sel.options].some((o) => o.value === String(secs))) {
    sel.append(el('option', { value: String(secs), text: `every ${secs} s` }));
  }
  sel.value = String(secs);
  sel.title = secs
    ? `the whole board — sidebar, counts and message list — reloads every ${fmtSecs(secs)}`
    : 'auto-refresh is off: nothing reloads until you press the reload button';
}

function fmtSecs(n) {
  return n < 120 ? `${n} s` : n < 7200 ? `${Math.round(n / 60)} min` : `${Math.round(n / 3600)} h`;
}

// -------------------------------------------------------------------- theme
// The palette itself lives in style.css under [data-theme="light"]; here we only
// decide which one is on, and remember the choice.
function theme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(next) {
  document.documentElement.dataset.theme = next;
  LS.theme = next;
  const b = $('#btn-theme');
  b.textContent = next === 'light' ? '\u263E' : '\u2600'; // show the mode you would switch to
  b.title = `Switch to ${next === 'light' ? 'dark' : 'light'} mode`;
  b.setAttribute('aria-label', b.title);
}

async function openSettings(note) {
  $('#set-token').value = LS.token;
  $('#set-interval').value = refreshSecs();
  $('#set-health').textContent = note ||
    `db: ${S.counts ? `${fmtNum(S.counts.messages)} messages stored` : '?'} · ` +
    `unassigned grace: ${S.pendingDays ?? 10} days` +
    (S.counts?.pending_threads || S.counts?.pending_channels
      ? ` · ${fmtNum((S.counts.pending_threads || 0) + (S.counts.pending_channels || 0))} unassigned now`
      : '');
  // server-wide settings live in the database, not in this browser
  const ret = $('#set-retention');
  ret.disabled = true;
  ret.value = '';
  ret.placeholder = 'loading…';
  try {
    const d = await api('/api/settings');
    ret.value = d.settings.retention_days;
    ret.placeholder = '';
    ret.disabled = false;
  } catch {
    ret.placeholder = 'server unreachable';
  }
  $('#dlg-settings').showModal();
}

// ----------------------------------------------------------------------- boot

(async function main() {
  bindUi();
  $('#set-save').addEventListener('click', async () => {
    LS.token = $('#set-token').value.trim();
    LS.interval = Math.max(0, Math.min(Number($('#set-interval').value) || 0, 3600));
    setupTimer();
    renderRefreshControl();
    const ret = $('#set-retention');
    const want = Number(ret.value);
    if (!ret.disabled && ret.value !== '' && Number.isInteger(want) && want !== S.retentionDays) {
      try {
        const d = await api('/api/settings', { method: 'POST', body: { retention_days: want } });
        S.retentionDays = d.settings.retention_days;
        setStatus(d.deleted
          ? `retention: deleted ${fmtNum(d.deleted)} old message(s)`
          : `retention: ${d.settings.retention_days ? `keeping ${d.settings.retention_days} days` : 'keeping everything'}`);
      } catch (err) {
        setStatus(`retention: ${err.message}`, true);
      }
    }
    reload();
  });
  try {
    const h = await api('/api/health');
    S.pendingDays = h.pending_days;
    S.retentionDays = h.retention_days;
    S.counts = h.counts;
  } catch (err) {
    setStatus(`server unreachable: ${err.message}`, true);
  }
  S.scope = readHash();
  applyTheme(theme()); // sync the switch with whatever the pre-paint script decided
  renderRefreshControl();
  renderMdControl();
  await reload();
  setupTimer();
})();
