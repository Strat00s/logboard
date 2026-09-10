'use strict';
// message_viewer — local log/message board.
// HTTP API + static UI. Storage: SQLite (see lib/db.js).

const path = require('path');
const express = require('express');
const { Store, HttpError, parseTs, nowIso } = require('./lib/db');

const VERSION = require('./package.json').version;

// ---------------------------------------------------------------------- config

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--host' || a === '-h') out.host = next();
    else if (a === '--db' || a === '-d') out.db = next();
    else if (a === '--token' || a === '-k') out.token = next();
    else if (a === '--pending-days') out.pendingDays = Number(next());
    else if (a === '--sweep-minutes') out.sweepMinutes = Number(next());
    else if (a === '--max-body') out.maxBody = next();
    else if (a === '--help' || a === '--usage') out.help = true;
    else { console.error(`unknown option: ${a}\n`); out.help = true; }
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
if (argv.help) {
  console.log(`message_viewer ${VERSION}

usage: node server.js [--port 8421] [--host 0.0.0.0] [--db ./data/messages.db]
                      [--token SECRET] [--pending-days 10] [--max-body 8mb]
                      [--sweep-minutes 15]

env: MV_PORT, MV_HOST, MV_DB, MV_TOKEN, MV_PENDING_DAYS, MV_MAX_BODY, MV_SWEEP_MINUTES
`);
  process.exit(0);
}

// `MV_X=""` in a systemd unit or CI env means "unset", not "zero".
const setting = (flag, env, fallback) => {
  if (flag !== undefined) return flag;
  const v = process.env[env];
  return v === undefined || v === '' ? fallback : v;
};

const CONFIG = {
  port: Number(setting(argv.port, 'MV_PORT', 8421)),
  host: setting(argv.host, 'MV_HOST', '0.0.0.0'),
  db: setting(argv.db, 'MV_DB', path.join(__dirname, 'data', 'messages.db')),
  token: setting(argv.token, 'MV_TOKEN', ''),
  pendingDays: Number(setting(argv.pendingDays, 'MV_PENDING_DAYS', 10)),
  maxBody: setting(argv.maxBody, 'MV_MAX_BODY', '8mb'),
  sweepMinutes: Number(setting(argv.sweepMinutes, 'MV_SWEEP_MINUTES', 15)),
};

const store = new Store(CONFIG.db, { pendingDays: CONFIG.pendingDays });

// ---------------------------------------------------------------------- server

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: CONFIG.maxBody }));

const log = (...a) => console.log(new Date().toISOString(), ...a);

// --- auth: only write operations need the token (when one is configured)
function requireToken(req, res, next) {
  if (!CONFIG.token) return next();
  const given =
    req.get('x-post-token') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    '';
  if (given !== CONFIG.token) return next(new HttpError(401, 'bad or missing token'));
  return next();
}

// ------------------------------------------------------------------- serializers

const chanView = (c) => ({
  id: c.id,
  name: c.name,
  position: c.position,
  pending: !!c.pending,
  expires_at: c.expires_at,
  created_at: c.created_at,
});

const threadView = (t) => ({
  id: t.id,
  channel_id: t.channel_id,
  name: t.name,
  position: t.position,
  pending: !!t.pending,
  expires_at: t.expires_at,
  created_at: t.created_at,
});

function targetPayload(req) {
  // channel / thread / tags may arrive as JSON body, headers or query params
  const j = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const pick = (...keys) => {
    for (const k of keys) if (j[k] !== undefined && j[k] !== null && j[k] !== '') return j[k];
    return undefined;
  };
  const headerList = (h) => (h ? String(h) : undefined);
  const split = (v) =>
    v === undefined
      ? undefined
      : Array.isArray(v)
        ? v.map((x) => String(x).trim()).filter(Boolean)
        : String(v)
            .split(/[,\s]+/)
            .map((x) => x.trim().replace(/^#/, ''))
            .filter(Boolean);

  return {
    channel: pick('channel', 'chan', 'c') ?? headerList(req.get('x-channel')) ?? req.query.channel,
    thread: pick('thread', 'topic', 't') ?? headerList(req.get('x-thread')) ?? req.query.thread,
    tags: split(pick('tags', 'tag') ?? req.get('x-tags') ?? req.query.tags),
    ts: pick('ts', 'timestamp', 'time') ?? req.query.ts ?? headerList(req.get('x-ts')),
    source: pick('source', 'host', 'from') ?? headerList(req.get('x-source')) ?? req.query.source,
    text: pick('text', 'body', 'message', 'msg', 'log'),
    envelope: Object.keys(j).length > 0,
  };
}

// Read state is per browser: the UI sends a random id in X-Reader (or ?reader=).
// Requests without one simply get no unread information.
app.use((req, _res, next) => {
  const raw = req.get('x-reader') || req.query.reader;
  const id = typeof raw === 'string' ? raw.trim().slice(0, 64) : '';
  req.reader = /^[A-Za-z0-9._-]+$/i.test(id) ? id : null;
  next();
});


app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    time: nowIso(),
    auth: !!CONFIG.token,
    pending_days: CONFIG.pendingDays,
    counts: store.counts(req.reader),
  });
});

app.get('/api/tree', (req, res) => {
  maybeSweep();
  res.json({ ok: true, channels: store.listChannels(req.reader), counts: store.counts(req.reader) });
});

app.get('/api/tags', (req, res) => {
  res.json({ ok: true, tags: store.listTags() });
});

app.get('/api/messages/:id', (req, res, next) => {
  const msg = store.getMessage(Number(req.params.id));
  if (!msg) return next(new HttpError(404, 'no such message'));
  res.json({ ok: true, message: msg });
});

app.get('/api/messages', (req, res, next) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const mode = req.query.mode === 'regex' ? 'regex' : 'text';
  if (!q.trim() && mode === 'regex') return next(new HttpError(400, 'regex mode needs q'));

  let threadId = null;
  let channelId = null;
  if (req.query.thread) {
    const t = store.findThread(req.query.channel ? store.findChannel(req.query.channel)?.id ?? null : null, req.query.thread);
    if (!t) throw new HttpError(404, `no such thread "${req.query.thread}"`);
    threadId = t.id;
    channelId = t.channel_id;
  } else if (req.query.channel) {
    const c = store.findChannel(req.query.channel);
    if (!c) throw new HttpError(404, `no such channel "${req.query.channel}"`);
    channelId = c.id;
  }

  const tags = String(req.query.tags || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let result;
  try {
    result = store.search({
      q,
      mode,
      cs: req.query.cs === '1' || req.query.cs === 'true',
      channelId,
      threadId,
      tags,
      tagMatch: req.query.tag_match === 'any' ? 'any' : 'all',
      from: parseTs(req.query.from) || undefined,
      to: parseTs(req.query.to) || undefined,
      limit: req.query.limit,
      offset: req.query.offset,
      sort: req.query.sort === 'asc' ? 'asc' : 'desc',
      truncate: req.query.truncate === undefined ? 8000 : Number(req.query.truncate),
      reader: req.reader,
    });
  } catch (err) {
    if (err instanceof SyntaxError) throw new HttpError(400, `invalid regex: ${err.message}`);
    throw err;
  }
  res.json({ ok: true, ...result });
});

// ------------------------------------------------------------------ write APIs

// Posting endpoint. Accepts:
//   JSON  {channel, thread, text, tags[], ts, source}
//   raw   body = message text, targets in X-Channel / X-Thread / X-Tags headers
app.post(
  ['/api/post', '/api/messages'],
  requireToken,
  express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], limit: CONFIG.maxBody }),
  (req, res, next) => {
    const t = targetPayload(req);
    let body = t.text;
    if (body === undefined) {
      const isJson = (req.get('content-type') || '').includes('application/json');
      if (isJson) return next(new HttpError(400, 'JSON body needs "text" (the message content)'));
      if (t.envelope) return next(new HttpError(400, 'JSON body needs "text" (the message content)'));
      body = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    }
    if (typeof body !== 'string') return next(new HttpError(400, 'message text must be a string'));
    if (!body.trim()) return next(new HttpError(400, 'empty message'));

    const { channel, thread, created } = store.resolveTarget(
      t.channel || 'default',
      t.thread || 'general',
    );
    const msg = store.addMessage({
      threadId: thread.id,
      body: body.replace(/\r\n/g, '\n'),
      ts: parseTs(t.ts) || nowIso(),
      tags: t.tags || [],
      source: t.source,
    });
    log(
      `post ${channel.name}/${thread.name} #${msg.id} ${msg.bytes}B` +
        `${msg.tags.length ? ` tags=${msg.tags.join(',')}` : ''}`,
    );
    res.status(created.channel || created.thread ? 201 : 200).json({
      ok: true,
      message: {
        id: msg.id,
        ts: msg.ts,
        chars: msg.chars,
        bytes: msg.bytes,
        tags: msg.tags,
        source: msg.source,
      },
      channel: { ...chanView(channel), created: created.channel },
      thread: { ...threadView(thread), created: created.thread },
    });
  },
);

app.post('/api/channels', requireToken, (req, res) => {
  const c = store.createChannel(req.body?.name);
  log(`channel created: ${c.name}`);
  res.status(201).json({ ok: true, channel: chanView(c) });
});

app.patch('/api/channels/:id', requireToken, (req, res) => {
  const c = store.renameChannel(Number(req.params.id), req.body?.name);
  res.json({ ok: true, channel: chanView(c) });
});

app.post('/api/channels/reorder', requireToken, (req, res) => {
  res.json({ ok: true, channels: store.reorderChannels(req.body?.ids) });
});

app.post('/api/channels/:id/adopt', requireToken, (req, res) => {
  const c = store.adoptChannel(Number(req.params.id));
  log(`channel adopted: ${c.name}`);
  res.json({ ok: true, channel: chanView(c) });
});

app.delete('/api/channels/:id', requireToken, (req, res) => {
  const r = store.deleteChannel(Number(req.params.id));
  log(`channel deleted: ${r.name}`);
  res.json({ ok: true, ...r });
});

app.post('/api/threads', requireToken, (req, res) => {
  const ch =
    req.body?.channel_id !== undefined
      ? store.mustGetChannel(req.body.channel_id)
      : store.findChannel(req.body?.channel);
  if (!ch) throw new HttpError(404, 'channel not found');
  const t = store.createThread(ch.id, req.body?.name);
  log(`thread created: ${ch.name}/${t.name}`);
  res.status(201).json({ ok: true, channel: chanView(ch), thread: threadView(t) });
});

app.patch('/api/threads/:id', requireToken, (req, res) => {
  const id = Number(req.params.id);
  let thread = store.mustGetThread(id);
  if (req.body?.name !== undefined && req.body.name !== null && req.body.name !== thread.name) {
    thread = store.renameThread(id, req.body.name);
  }
  const moveTo =
    req.body?.channel_id !== undefined
      ? Number(req.body.channel_id)
      : req.body?.channel !== undefined
        ? store.findChannel(req.body.channel)?.id
        : undefined;
  if (moveTo !== undefined && moveTo !== thread.channel_id) {
    thread = store.moveThread(id, moveTo);
  }
  res.json({ ok: true, thread: threadView(thread) });
});

app.post('/api/threads/reorder', requireToken, (req, res) => {
  const ch =
    req.body?.channel_id !== undefined
      ? store.mustGetChannel(req.body.channel_id)
      : store.findChannel(req.body?.channel);
  if (!ch) throw new HttpError(404, 'channel not found');
  res.json({ ok: true, channels: store.reorderThreads(ch.id, req.body?.ids) });
});

app.post('/api/threads/:id/adopt', requireToken, (req, res) => {
  const t = store.adoptThread(Number(req.params.id));
  log(`thread adopted: #${t.id}`);
  res.json({ ok: true, thread: threadView(t) });
});

app.delete('/api/threads/:id', requireToken, (req, res) => {
  const r = store.deleteThread(Number(req.params.id));
  log(`thread deleted: #${r.id}`);
  res.json({ ok: true, ...r });
});

app.patch('/api/messages/:id', requireToken, (req, res) => {
  const id = Number(req.params.id);
  const msg = store.getMessage(id);
  if (!msg) throw new HttpError(404, 'no such message');
  if (Array.isArray(req.body?.add_tags)) store.addTags(id, req.body.add_tags);
  if (Array.isArray(req.body?.remove_tags)) store.removeTags(id, req.body.remove_tags);
  if (Array.isArray(req.body?.tags)) {
    store.removeTags(id, msg.tags);
    store.addTags(id, req.body.tags);
  }
  res.json({ ok: true, message: store.getMessage(id) });
});

app.post('/api/messages/delete', requireToken, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) throw new HttpError(400, 'ids[] is required');
  const deleted = store.deleteMessages(ids);
  log(`messages deleted: ${deleted}`);
  res.json({ ok: true, deleted });
});

app.delete('/api/messages/:id', requireToken, (req, res) => {
  const deleted = store.deleteMessages([Number(req.params.id)]);
  if (!deleted) throw new HttpError(404, 'no such message');
  res.json({ ok: true, deleted: 1 });
});

app.post('/api/tags/rename', requireToken, (req, res) => {
  const tag = store.renameTag(req.body?.from, req.body?.to);
  res.json({ ok: true, tag });
});

app.delete('/api/tags/:ref', requireToken, (req, res) => {
  res.json({ ok: true, ...store.deleteTag(req.params.ref) });
});

app.post('/api/admin/sweep', requireToken, (_req, res) => {
  res.json({ ok: true, removed: sweep() });
});

// Read state. Marking a thread read is how the UI "clicks away": every message up to
// `last_id` (default: the newest) stops being unread. Needs the reader id, no token —
// it only ever moves that browser's own watermarks.
app.post('/api/reads/:id', (req, res, next) => {
  if (!req.reader) return next(new HttpError(400, 'send an X-Reader id to track read state'));
  const upto = req.body?.last_id ?? req.query.last_id;
  const r = store.markRead(req.reader, Number(req.params.id), upto === undefined ? undefined : Number(upto));
  res.json({ ok: true, ...r });
});

app.post('/api/reads', (req, res, next) => {
  if (!req.reader) return next(new HttpError(400, 'send an X-Reader id to track read state'));
  // scope by id or by channel name, like everywhere else in the API
  const scope = req.body?.channel_id ?? req.query.channel ?? req.query.channel_id;
  if (scope === undefined || scope === null || scope === '') {
    return res.json({ ok: true, ...store.markAllRead(req.reader, null) });
  }
  const channel = store.findChannel(scope); // accepts an id or a name
  if (!channel) return next(new HttpError(404, `no such channel "${scope}"`));
  res.json({ ok: true, channel_id: channel.id, ...store.markAllRead(req.reader, channel.id) });
});

// ------------------------------------------------------------------- static UI

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use((req, res) => res.status(404).json({ ok: false, error: `no route ${req.method} ${req.path}` }));

app.use((err, req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: `body too large (max ${CONFIG.maxBody})` });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'invalid JSON body' });
  }
  const status = err?.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ ok: false, error: err?.message || 'internal error' });
});

// ----------------------------------------------------------------------- boot

// Expiry is applied at startup, on an interval, and — so that the Unassigned
// panel never shows a stale row — when the sidebar refreshes. A read endpoint
// must not turn into a delete on every request, so that last trigger is
// rate-limited.
const SWEEP_READ_MS = Math.min(Math.max(CONFIG.sweepMinutes, 1) * 60_000, 30_000);
let lastSweepAt = 0;

function sweep() {
  lastSweepAt = Date.now();
  const r = store.sweepPending();
  if (r.channels || r.threads) log(`expired pending: ${r.channels} channel(s), ${r.threads} thread(s)`);
  return r;
}

function maybeSweep() {
  if (Date.now() - lastSweepAt < SWEEP_READ_MS) return null;
  return sweep();
}

const server = app.listen(CONFIG.port, CONFIG.host, () => {
  log(`message_viewer ${VERSION} on http://${CONFIG.host}:${CONFIG.port} (db: ${CONFIG.db})`);
  if (CONFIG.host === '0.0.0.0') log('listening on all interfaces — restrict access to your LAN');
  if (!CONFIG.token) log('no token configured: anyone reachable can post and edit');
  sweep();
});

setInterval(sweep, Math.max(CONFIG.sweepMinutes, 1) * 60_000).unref?.();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
