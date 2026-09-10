'use strict';
// SQLite data layer: channels -> threads -> messages, plus tags and
// "pending" (unassigned) channels/threads created implicitly by posting.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- time helpers

// Accepts ISO-8601, "YYYY-MM-DD HH:MM:SS", epoch seconds/millis, or relative
// offsets like "-7d" / "-24h" / "-30m" (relative to `ref`). Returns ISO string
// in UTC, or null when the value cannot be parsed.
function parseTs(value, ref = new Date()) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    let n = Number(value);
    if (n > 1e11) return new Date(n).toISOString(); // millis
    if (n > 0) n = n * 1000; // seconds
    return new Date(n).toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  const rel = /^(-|\+)?(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|d|w|M|mo|y)\b$/i.exec(s);
  if (rel) {
    const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, M: 2592e6, y: 31536e6 };
    const unit = rel[3].toLowerCase();
    const key = unit === 'mo' ? 'M' : unit === 'sec' ? 's' : unit === 'min' ? 'm' : unit;
    const delta = Number(rel[2]) * mult[key];
    const out = new Date(ref.getTime() + (rel[1] === '-' ? -delta : delta));
    return out.toISOString();
  }
  const sqliteish = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  let iso = s;
  if (sqliteish && !sqliteish[4]) iso = `${s.replace(' ', 'T')}Z`; // treat bare as UTC
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ------------------------------------------------------------------ regex util

const reCache = new Map();
const RE_CACHE_MAX = 64;

// Compiles (and caches) a pattern; throws on invalid syntax so the API can
// answer 400 instead of blowing up mid-query.
function compile(pattern, ci) {
  const key = `${ci ? 'i' : ''}\u0000${pattern}`;
  let re = reCache.get(key);
  if (!re) {
    re = new RegExp(pattern, ci ? 'i' : '');
    if (reCache.size >= RE_CACHE_MAX) reCache.clear();
    reCache.set(key, re);
  }
  return re;
}

// ------------------------------------------------------------------ text utils

const charLen = (s) => Array.from(s).length; // codepoints, not UTF-16 units

function bytesLen(s) {
  return Buffer.byteLength(s, 'utf8');
}

// ------------------------------------------------------------------- migration

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  pending    INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_active_name ON channels (name COLLATE NOCASE) WHERE pending = 0;
CREATE UNIQUE INDEX IF NOT EXISTS channels_pend_name   ON channels (name COLLATE NOCASE) WHERE pending = 1;

CREATE TABLE IF NOT EXISTS threads (
  id         INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  pending    INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS threads_active_name ON threads (channel_id, name COLLATE NOCASE) WHERE pending = 0;
CREATE UNIQUE INDEX IF NOT EXISTS threads_pend_name   ON threads (channel_id, name COLLATE NOCASE) WHERE pending = 1;
CREATE INDEX IF NOT EXISTS threads_channel ON threads (channel_id);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  ts         TEXT NOT NULL,
  body       TEXT NOT NULL,
  chars      INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS message_tags (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, tag_id)
);
CREATE INDEX IF NOT EXISTS message_tags_tag ON message_tags (tag_id);

-- Read state. There are no accounts: a "reader" is an anonymous per-browser id held
-- in localStorage. baseline_id is the highest message id when that reader first
-- appeared, so messages predating it are never reported as unread. reads holds one
-- watermark per thread: the highest message id the reader saw in it.
CREATE TABLE IF NOT EXISTS readers (
  reader      TEXT PRIMARY KEY,
  baseline_id INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reads (
  reader       TEXT NOT NULL,
  thread_id    INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (reader, thread_id)
);
CREATE INDEX IF NOT EXISTS reads_reader ON reads (reader);
`;

// ----------------------------------------------------------------------- class

class Store {
  constructor(file, { pendingDays = 10 } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.pendingDays = pendingDays;

    // `X REGEXP Y` invokes regexp(Y, X) — pattern first.
    this.db.function('regexp', { deterministic: false }, (pattern, value) => {
      if (value === null || value === undefined) return 0;
      try {
        return compile(String(pattern), true).test(String(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    });
    this.compile = compile;
  }

  // ------------------------------------------------------------- tag helpers

  tagRow(name) {
    return this.db.prepare('SELECT * FROM tags WHERE name = ?').get(String(name).trim()) || null;
  }

  tagId(name) {
    const row = this.tagRow(name);
    return row ? row.id : null;
  }

  ensureTag(name) {
    const clean = String(name).trim().replace(/^#/, '');
    if (!clean) throw new HttpError(400, 'empty tag name');
    const existing = this.tagId(clean);
    if (existing) return existing;
    return Number(
      this.db.prepare('INSERT INTO tags (name) VALUES (?) RETURNING id').get(clean).id,
    );
  }

  // ---------------------------------------------------------------- read state
  // A reader is an opaque per-browser id. The first time one is seen its baseline is
  // the current last message id, so nothing already stored counts as unread.
  reader(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    const row = this.db.prepare('SELECT * FROM readers WHERE reader = ?').get(key);
    if (row) return row;
    const baseline = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get().m;
    this.db
      .prepare('INSERT INTO readers (reader, baseline_id, created_at) VALUES (?, ?, ?)')
      .run(key, baseline, nowIso());
    return { reader: key, baseline_id: baseline, created_at: nowIso() };
  }

  // Highest message id each thread has for this reader: everything above it is unread.
  readFloors(id) {
    const rdr = this.reader(id);
    if (!rdr) return null;
    const rows = this.db
      .prepare(
        `SELECT t.id AS thread_id,
                MAX(COALESCE(r.last_read_id, 0), ?) AS floor
           FROM threads t
           LEFT JOIN reads r ON r.thread_id = t.id AND r.reader = ?`,
      )
      .all(rdr.baseline_id, rdr.reader);
    return { reader: rdr.reader, baseline: rdr.baseline_id, floors: new Map(rows.map((r) => [r.thread_id, r.floor])) };
  }

  // thread id -> how many messages sit above that thread's floor, in one statement.
  unreadByThread(id) {
    const rdr = this.reader(id);
    if (!rdr) return null;
    const rows = this.db
      .prepare(
        `SELECT t.id AS thread_id,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.thread_id = t.id
                    AND m.id > MAX(COALESCE(r.last_read_id, 0), ?)) AS n
           FROM threads t
           LEFT JOIN reads r ON r.thread_id = t.id AND r.reader = ?`,
      )
      .all(rdr.baseline_id, rdr.reader);
    return new Map(rows.filter((r) => r.n > 0).map((r) => [r.thread_id, r.n]));
  }

  // Everything in the thread up to `upto` (default: its newest message) counts as
  // seen. Watermarks only ever move forward. Returns how much became read.
  markRead(id, threadId, upto) {
    const rdr = this.reader(id);
    if (!rdr) throw new HttpError(400, 'read state needs a reader id');
    const th = this.mustGetThread(threadId);
    const floor = Math.max(this.readFloors(id).floors.get(th.id) ?? 0, 0);
    const target =
      upto === undefined || upto === null
        ? this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE thread_id = ?').get(th.id).m
        : Number(upto);
    const marked = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE thread_id = ? AND id > ? AND id <= ?`,
      )
      .get(th.id, floor, Number.isFinite(target) ? target : 0).n;
    this.db
      .prepare(
        `INSERT INTO reads (reader, thread_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(reader, thread_id)
          DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = excluded.updated_at`,
      )
      .run(rdr.reader, th.id, Math.max(floor, Number.isFinite(target) ? target : 0), nowIso());
    return { thread_id: th.id, marked, unread: this.unreadByThread(id)?.get(th.id) ?? 0 };
  }

  // Mark several threads read at once (whole board, or one channel).
  markAllRead(id, channelId = null) {
    const rdr = this.reader(id);
    if (!rdr) throw new HttpError(400, 'read state needs a reader id');
    const threads = channelId
      ? this.db.prepare('SELECT id FROM threads WHERE channel_id = ?').all(Number(channelId))
      : this.db.prepare('SELECT id FROM threads').all();
    const now = nowIso();
    const upsert = this.db.prepare(
      `INSERT INTO reads (reader, thread_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(reader, thread_id)
        DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = excluded.updated_at`,
    );
    const lastId = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get().m;
    const before = this.unreadByThread(id);
    let marked = 0;
    const tx = this.db.transaction(() => {
      for (const t of threads) {
        marked += before?.get(t.id) ?? 0;
        upsert.run(rdr.reader, t.id, lastId, now);
      }
    });
    tx();
    return { threads: threads.length, marked };
  }

  tagsFor(ids) {
    const map = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return map;
    const chunks = chunk([...ids], 500);
    for (const group of chunks) {
      const rows = this.db
        .prepare(
          `SELECT mt.message_id AS mid, t.name AS name
             FROM message_tags mt JOIN tags t ON t.id = mt.tag_id
            WHERE mt.message_id IN (${group.map(() => '?').join(',')})
            ORDER BY t.name COLLATE NOCASE`,
        )
        .all(...group);
      for (const r of rows) map.get(r.mid).push(r.name);
    }
    return map;
  }

  addTags(messageId, names) {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO message_tags (message_id, tag_id) VALUES (?, ?)',
    );
    for (const n of names || []) ins.run(messageId, this.ensureTag(n));
  }

  removeTags(messageId, names) {
    const del = this.db.prepare(
      'DELETE FROM message_tags WHERE message_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)',
    );
    for (const n of names || []) del.run(messageId, String(n).trim().replace(/^#/, ''));
  }

  // ------------------------------------------------------- channel / thread

  findChannel(ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const s = String(ref);
    if (/^\d+$/.test(s)) return this.db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(s)) || null;
    return (
      this.db
        .prepare('SELECT * FROM channels WHERE name = ? COLLATE NOCASE ORDER BY pending ASC, id ASC')
        .get(s.trim()) || null
    );
  }

  findThread(channelId, ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const s = String(ref);
    if (/^\d+$/.test(s)) {
      const t = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(s));
      if (!t) return null;
      return channelId === null || t.channel_id === channelId ? t : null;
    }
    return (
      this.db
        .prepare(
          'SELECT * FROM threads WHERE channel_id = ? AND name = ? COLLATE NOCASE ORDER BY pending ASC, id ASC',
        )
        .get(channelId, s.trim()) || null
    );
  }

  nextPosition(table, where, params) {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM ${table} WHERE ${where}`)
      .get(...params);
    return row.p;
  }

  createChannel(name) {
    const clean = cleanName(name, 'channel');
    const dup = this.db
      .prepare('SELECT id FROM channels WHERE pending = 0 AND name = ? COLLATE NOCASE')
      .get(clean);
    if (dup) throw new HttpError(409, `channel "${clean}" already exists`);
    // a pending channel of that name (created by a script post) becomes real
    const pending = this.db
      .prepare('SELECT id FROM channels WHERE pending = 1 AND name = ? COLLATE NOCASE')
      .get(clean);
    if (pending) return this.adoptChannel(pending.id);
    const now = nowIso();
    const position = this.nextPosition('channels', 'pending = 0', []);
    const id = Number(
      this.db
        .prepare(
          'INSERT INTO channels (name, position, pending, created_at, updated_at) VALUES (?, ?, 0, ?, ?) RETURNING id',
        )
        .get(clean, position, now, now).id,
);
    return this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  }

  createThread(channelId, name) {
    const clean = cleanName(name, 'thread');
    const ch = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!ch) throw new HttpError(404, 'no such channel');
    const dup = this.db
      .prepare('SELECT id FROM threads WHERE channel_id = ? AND pending = 0 AND name = ? COLLATE NOCASE')
      .get(channelId, clean);
    if (dup) throw new HttpError(409, `thread "${clean}" already exists in channel "${ch.name}"`);
    const pending = this.db
      .prepare('SELECT id FROM threads WHERE channel_id = ? AND pending = 1 AND name = ? COLLATE NOCASE')
      .get(channelId, clean);
    if (pending) return this.adoptThread(pending.id);
    const now = nowIso();
    const position = this.nextPosition('threads', 'channel_id = ? AND pending = 0', [channelId]);
    const id = Number(
      this.db
        .prepare(
          'INSERT INTO threads (channel_id, name, position, pending, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?) RETURNING id',
        )
        .get(channelId, clean, position, now, now).id,
    );
    return this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  }

  // Resolve (creating as pending when missing) the channel/thread a post
  // targets. Newly created entities expire after `pendingDays`.
  resolveTarget(channelName, threadName) {
    const cn = cleanName(channelName, 'channel');
    const tn = cleanName(threadName, 'thread');
    const created = { channel: false, thread: false };
    const expires = () => new Date(Date.now() + this.pendingDays * 864e5).toISOString();
    const now = nowIso();

    let channel = this.findChannel(cn);
    if (!channel) {
      const position = this.nextPosition('channels', 'pending = 1', []);
      const id = Number(
        this.db
          .prepare(
            'INSERT INTO channels (name, position, pending, expires_at, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?) RETURNING id',
          )
          .get(cn, position, expires(), now, now).id,
      );
      channel = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
      created.channel = true;
    } else if (channel.pending) {
      // grace period restarts on activity, so a busy-but-unadopted target
      // is never deleted out from under the script posting to it
      this.db.prepare('UPDATE channels SET expires_at = ? WHERE id = ?').run(expires(), channel.id);
      channel = this.mustGetChannel(channel.id);
    }

    let thread = this.findThread(channel.id, tn);
    if (!thread) {
      const position = this.nextPosition('threads', 'channel_id = ? AND pending = 1', [channel.id]);
      const id = Number(
        this.db
          .prepare(
            'INSERT INTO threads (channel_id, name, position, pending, expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?) RETURNING id',
          )
          .get(channel.id, tn, position, expires(), now, now).id,
      );
      thread = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
      created.thread = true;
    } else if (thread.pending) {
      this.db.prepare('UPDATE threads SET expires_at = ? WHERE id = ?').run(expires(), thread.id);
      thread = this.mustGetThread(thread.id);
    }
    return { channel, thread, created };
  }

  renameChannel(id, name) {
    const clean = cleanName(name, 'channel');
    const ch = this.mustGetChannel(id);
    const dup = this.db
      .prepare('SELECT id FROM channels WHERE pending = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(ch.pending, clean, id);
    if (dup) throw new HttpError(409, `channel "${clean}" already exists`);
    this.db
      .prepare('UPDATE channels SET name = ?, updated_at = ? WHERE id = ?')
      .run(clean, nowIso(), id);
    return this.mustGetChannel(id);
  }

  renameThread(id, name) {
    const clean = cleanName(name, 'thread');
    const th = this.mustGetThread(id);
    const dup = this.db
      .prepare(
        'SELECT id FROM threads WHERE channel_id = ? AND pending = ? AND name = ? COLLATE NOCASE AND id != ?',
      )
      .get(th.channel_id, th.pending, clean, id);
    if (dup) throw new HttpError(409, `thread "${clean}" already exists in this channel`);
    this.db.prepare('UPDATE threads SET name = ?, updated_at = ? WHERE id = ?').run(clean, nowIso(), id);
    return this.mustGetThread(id);
  }

  moveThread(id, channelId) {
    const th = this.mustGetThread(id);
    const ch = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(channelId));
    if (!ch) throw new HttpError(404, 'no such channel');
    const dup = this.db
      .prepare(
        'SELECT id FROM threads WHERE channel_id = ? AND pending = ? AND name = ? COLLATE NOCASE AND id != ?',
      )
      .get(ch.id, th.pending, th.name, id);
    if (dup) throw new HttpError(409, `thread "${th.name}" already exists in channel "${ch.name}"`);
    const position = this.nextPosition('threads', 'channel_id = ? AND pending = 0', [ch.id]);
    this.db
      .prepare('UPDATE threads SET channel_id = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(ch.id, position, nowIso(), id);
    return this.mustGetThread(id);
  }

  reorderChannels(ids) {
    const upd = this.db.prepare('UPDATE channels SET position = ? WHERE id = ? AND pending = 0');
    (ids || []).forEach((id, i) => upd.run(i, Number(id)));
    return this.listChannels();
  }

  reorderThreads(channelId, ids) {
    const upd = this.db.prepare(
      'UPDATE threads SET position = ? WHERE id = ? AND channel_id = ? AND pending = 0',
    );
    (ids || []).forEach((id, i) => upd.run(i, Number(id), Number(channelId)));
    return this.listChannels();
  }

  // Turn a pending (auto-created) channel into a real one. Merges into an
  // existing active channel of the same name when there is one.
  adoptChannel(id) {
    const ch = this.mustGetChannel(id);
    if (!ch.pending) return ch;
    const home = this.db
      .prepare('SELECT * FROM channels WHERE pending = 0 AND name = ? COLLATE NOCASE')
      .get(ch.name);
    const now = nowIso();
    if (!home) {
      const position = this.nextPosition('channels', 'pending = 0', []);
      this.db
        .prepare('UPDATE channels SET pending = 0, expires_at = NULL, position = ?, updated_at = ? WHERE id = ?')
        .run(position, now, id);
      // adopting the channel adopts everything it collected
      for (const th of this.pendingThreads(id)) this.promoteThread(th, id, now);
      return this.mustGetChannel(id);
    }
    // an active channel with the same name already exists: merge into it
    for (const th of this.pendingThreads(ch.id)) this.promoteThread(th, home.id, now);
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
    return this.mustGetChannel(home.id);
  }

  pendingThreads(channelId) {
    return this.db
      .prepare('SELECT * FROM threads WHERE channel_id = ? AND pending = 1 ORDER BY id')
      .all(channelId);
  }

  // Make thread `th` a real thread of `channelId`. Messages are merged into a
  // same-named thread when one is there already (names match ignoring case).
  promoteThread(th, channelId, now = nowIso()) {
    const twin = this.db
      .prepare(
        `SELECT * FROM threads
          WHERE channel_id = ? AND id != ? AND name = ? COLLATE NOCASE
          ORDER BY pending ASC, id ASC`,
      )
      .get(channelId, th.id, th.name);
    if (twin) {
      this.db.prepare('UPDATE messages SET thread_id = ? WHERE thread_id = ?').run(twin.id, th.id);
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(th.id);
      if (twin.pending) {
        this.db
          .prepare('UPDATE threads SET pending = 0, expires_at = NULL, updated_at = ? WHERE id = ?')
          .run(now, twin.id);
      }
      return this.mustGetThread(twin.id);
    }
    const position = this.nextPosition('threads', 'channel_id = ? AND pending = 0', [channelId]);
    this.db
      .prepare(
        'UPDATE threads SET channel_id = ?, pending = 0, expires_at = NULL, position = ?, updated_at = ? WHERE id = ?',
      )
      .run(channelId, position, now, th.id);
    return this.mustGetThread(th.id);
  }

  adoptThread(id) {
    const th = this.mustGetThread(id);
    if (!th.pending) return th;
    let ch = this.mustGetChannel(th.channel_id);
    const now = nowIso();
    if (ch.pending) {
      // The thread sits in an unassigned channel. Claiming it claims that
      // channel too — the host is evidently real — but sibling threads stay
      // under review until they are adopted or expire.
      const home = this.db
        .prepare('SELECT * FROM channels WHERE pending = 0 AND name = ? COLLATE NOCASE')
        .get(ch.name);
      if (home) {
        ch = home; // an active channel of this name already exists: live there
      } else {
        const position = this.nextPosition('channels', 'pending = 0', []);
        this.db
          .prepare('UPDATE channels SET pending = 0, expires_at = NULL, position = ?, updated_at = ? WHERE id = ?')
          .run(position, now, ch.id);
      }
    }
    return this.promoteThread(this.mustGetThread(id), ch.id);
  }

  // Delete everything pending whose grace period elapsed. Returns counts.
  sweepPending() {
    const now = nowIso();
    const threads = this.db
      .prepare('SELECT id FROM threads WHERE pending = 1 AND expires_at IS NOT NULL AND expires_at < ?')
      .all(now)
      .map((r) => r.id);
    const channels = this.db
      .prepare('SELECT id FROM channels WHERE pending = 1 AND expires_at IS NOT NULL AND expires_at < ?')
      .all(now)
      .map((r) => r.id);
    const delT = this.db.prepare('DELETE FROM threads WHERE id = ?');
    const delC = this.db.prepare('DELETE FROM channels WHERE id = ?');
    for (const id of threads) delT.run(id);
    for (const id of channels) delC.run(id);
    // deleting a pending channel cascade-deletes the threads it collected
    return { channels: channels.length, threads: threads.length };
  }

  mustGetChannel(id) {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'no such channel');
    return row;
  }

  mustGetThread(id) {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'no such thread');
    return row;
  }

  deleteChannel(id) {
    const ch = this.mustGetChannel(id);
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
    return { deleted: 'channel', id: ch.id, name: ch.name };
  }

  deleteThread(id) {
    const th = this.mustGetThread(id);
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(th.id);
    return { deleted: 'thread', id: th.id, name: th.name };
  }

  // --------------------------------------------------------------- messages

  addMessage({ threadId, body, ts, tags, source }) {
    if (!Number.isInteger(threadId)) throw new HttpError(500, 'addMessage needs an existing thread id');
    if (typeof body !== 'string') throw new HttpError(400, 'message body must be text');
    const when = ts || nowIso();
    const info = this.db
      .prepare(
        'INSERT INTO messages (thread_id, ts, body, chars, bytes, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(threadId, when, body, charLen(body), bytesLen(body), source || null, nowIso());
    const id = Number(info.lastInsertRowid);
    this.addTags(id, tags || []);
    return this.getMessage(id);
  }

  getMessage(id) {
    const row = this.db
      .prepare(
        `SELECT m.*, t.name AS thread, t.pending AS thread_pending, c.id AS channel_id, c.name AS channel,
                c.pending AS channel_pending
           FROM messages m
           JOIN threads t ON t.id = m.thread_id
           JOIN channels c ON c.id = t.channel_id
          WHERE m.id = ?`,
      )
      .get(Number(id));
    if (!row) return null;
    row.tags = [...this.tagsFor([row.id]).get(row.id)];
    return row;
  }

  deleteMessages(ids) {
    const del = this.db.prepare('DELETE FROM messages WHERE id = ?');
    let n = 0;
    for (const id of ids || []) {
      const r = del.run(Number(id));
      n += r.changes;
    }
    return n;
  }

  // Core search: text/regex over message bodies, scoped by channel/thread,
  // filtered by tag set and time range.
  search(opts = {}) {
    const where = [];
    const params = {};

    if (opts.q) {
      if (opts.mode === 'regex') {
        compile(opts.q, !opts.cs); // validate before the query runs
        where.push('m.body REGEXP @q');
        params.q = opts.q;
      } else {
        where.push(opts.cs ? 'instr(m.body, @q) > 0' : 'instr(upper(m.body), upper(@q)) > 0');
        params.q = opts.q;
      }
    }

    if (opts.threadId) {
      where.push('m.thread_id = @threadId');
      params.threadId = opts.threadId;
    } else if (opts.channelId) {
      where.push('c.id = @channelId');
      params.channelId = opts.channelId;
    }

    const tags = (opts.tags || []).map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean);
    if (tags.length) {
      tags.forEach((t, i) => {
        params[`tg${i}`] = t;
      });
      const inList = tags.map((_, i) => `@tg${i}`).join(', ');
      const match = `t.name COLLATE NOCASE IN (${inList})`;
      const joined = 'FROM message_tags mt JOIN tags t ON t.id = mt.tag_id';
      if (opts.tagMatch === 'any') {
        where.push(`EXISTS (SELECT 1 ${joined} WHERE mt.message_id = m.id AND ${match})`);
      } else {
        where.push(
          `(SELECT COUNT(DISTINCT mt.tag_id) ${joined} WHERE mt.message_id = m.id AND ${match}) = ${tags.length}`,
        );
      }
    }

    if (opts.from) {
      where.push('m.ts >= @from');
      params.from = opts.from;
    }
    if (opts.to) {
      where.push('m.ts <= @to');
      params.to = opts.to;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages m
           JOIN threads t ON t.id = m.thread_id
           JOIN channels c ON c.id = t.channel_id ${whereSql}`,
      )
      .get(params).c;

    const dir = opts.sort === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 2000);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.ts, m.chars, m.bytes, m.source, m.body, m.thread_id,
                t.name AS thread, t.pending AS thread_pending,
                c.id AS channel_id, c.name AS channel, c.pending AS channel_pending
           FROM messages m
           JOIN threads t ON t.id = m.thread_id
           JOIN channels c ON c.id = t.channel_id
           ${whereSql}
          ORDER BY m.ts ${dir}, m.id ${dir}
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset });

    const tagMap = this.tagsFor(rows.map((r) => r.id));
    const floors = opts.reader ? this.readFloors(opts.reader) : null;
    const max = Number.isFinite(opts.truncate) ? opts.truncate : 8000;
    const messages = rows.map((r) => {
      const tags = tagMap.get(r.id);
      const cut = max > 0 && Array.from(r.body).length > max;
      return {
        id: r.id,
        ts: r.ts,
        chars: r.chars,
        bytes: r.bytes,
        source: r.source,
        thread_id: r.thread_id,
        thread: r.thread,
        thread_pending: r.thread_pending,
        channel_id: r.channel_id,
        channel: r.channel,
        tags,
        unread: floors ? r.id > (floors.floors.get(r.thread_id) ?? 0) : false,
        body: cut ? `${Array.from(r.body).slice(0, max).join('')}` : r.body,
        truncated: cut,
      };
    });
    return { total, limit, offset, messages };
  }

  listChannels(reader = null) {
    const unread = this.unreadByThread(reader);
    const channels = this.db
      .prepare('SELECT * FROM channels ORDER BY pending ASC, position ASC, id ASC')
      .all();
    const threads = this.db
      .prepare('SELECT * FROM threads ORDER BY pending ASC, position ASC, id ASC')
      .all();
    const stats = this.db
      .prepare(
        `SELECT thread_id, COUNT(*) AS n, MAX(ts) AS last_ts FROM messages GROUP BY thread_id`,
      )
      .all();
    const byThread = new Map(stats.map((s) => [s.thread_id, s]));
    const perChannel = new Map();
    const perChannelUnread = new Map();
    for (const t of threads) {
      const s = byThread.get(t.id);
      const tc = (perChannel.get(t.channel_id) || 0) + (s ? s.n : 0);
      perChannel.set(t.channel_id, tc);
      t.messages = s ? s.n : 0;
      t.last_ts = s ? s.last_ts : null;
      t.unread = unread?.get(t.id) ?? 0;
      perChannelUnread.set(t.channel_id, (perChannelUnread.get(t.channel_id) || 0) + t.unread);
    }
    return channels.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
      pending: !!c.pending,
      expires_at: c.expires_at,
      created_at: c.created_at,
      messages: perChannel.get(c.id) || 0,
      unread: perChannelUnread.get(c.id) || 0,
      threads: threads.filter((t) => t.channel_id === c.id).map((t) => ({
        id: t.id,
        name: t.name,
        position: t.position,
        pending: !!t.pending,
        expires_at: t.expires_at,
        created_at: t.created_at,
        messages: t.messages,
        unread: t.unread,
        last_ts: t.last_ts,
      })),
    }));
  }

  listTags() {
    return this.db
      .prepare(
        `SELECT t.id, t.name, COUNT(mt.message_id) AS messages
           FROM tags t LEFT JOIN message_tags mt ON mt.tag_id = t.id
          GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
      )
      .all();
  }

  renameTag(from, to) {
    const fromId = this.tagId(from);
    const target = String(to).trim().replace(/^#/, '');
    if (!target) throw new HttpError(400, 'tag name is required');
    if (!fromId) throw new HttpError(404, `no such tag "${from}"`);
    const intoId = this.tagId(target);
    if (intoId && intoId !== fromId) {
      // merging two tags: move the messages over, then drop the old tag
      this.db
        .prepare('INSERT OR IGNORE INTO message_tags (message_id, tag_id) SELECT message_id, ? FROM message_tags WHERE tag_id = ?')
        .run(intoId, fromId);
      this.db.prepare('DELETE FROM message_tags WHERE tag_id = ?').run(fromId);
      this.db.prepare('DELETE FROM tags WHERE id = ?').run(fromId);
      return this.tagRow(target);
    }
    this.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(target, fromId);
    return this.tagRow(target);
  }

  deleteTag(idOrName) {
    const ref = String(idOrName);
    const row = /^\d+$/.test(ref)
      ? this.db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(ref))
      : this.tagRow(ref);
    if (!row) throw new HttpError(404, 'no such tag');
    this.db.prepare('DELETE FROM message_tags WHERE tag_id = ?').run(row.id);
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(row.id);
    return { deleted: 'tag', id: row.id, name: row.name };
  }

  counts(id = null) {
    const g = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM messages) AS messages,
                (SELECT COUNT(*) FROM channels) AS channels,
                (SELECT COUNT(*) FROM threads) AS threads,
                (SELECT COUNT(*) FROM tags) AS tags,
                (SELECT COUNT(*) FROM channels WHERE pending = 1) AS pending_channels,
                (SELECT COUNT(*) FROM threads WHERE pending = 1) AS pending_threads`,
      )
      .get();
    // always present, so a client never has to distinguish "no reader" from "nothing unread"
    const unread = id ? this.unreadByThread(id) : null;
    g.unread = unread ? [...unread.values()].reduce((a, b) => a + b, 0) : 0;
    return g;
  }

  close() {
    this.db.close();
  }
}

// --------------------------------------------------------------------- utils

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function cleanName(name, what) {
  const s = String(name === undefined || name === null ? '' : name).trim();
  if (!s) throw new HttpError(400, `${what} name is required`);
  if (s.length > 200) throw new HttpError(400, `${what} name too long`);
  if (/[/\u0000-\u001f]/.test(s)) throw new HttpError(400, `${what} name contains illegal characters`);
  return s;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { Store, HttpError, parseTs, nowIso, charLen, bytesLen, compile };
