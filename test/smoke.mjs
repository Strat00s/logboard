'use strict';
/*
 * npm test — boots the real server on a throwaway database and drives it over
 * HTTP. No test framework, no mocks: it asserts the documented contract.
 *
 *   node test/smoke.mjs            # against a temp file database
 *   LB_TEST_DB=./data/x.db node test/smoke.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const DB = process.env.LB_TEST_DB || path.join(os.tmpdir(), `lb-smoke-${process.pid}.db`);
const PORT = 8400 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra).slice(0, 240)}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, body, { token, raw, base = BASE, reader } = {}) {
  const headers = {};
  if (token) headers['x-post-token'] = token;
  if (reader) headers['x-reader'] = reader;
  if (raw !== undefined) {
    headers['content-type'] = 'text/plain';
  } else if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const get = (p, base) => req('GET', p, undefined, { base });
const rget = (p, reader) => req('GET', p, undefined, { reader });
const rpost = (p, body, reader) => req('POST', p, body, { reader });
const post = (b, extra = {}) => req('POST', '/api/post', b, extra);

async function waitForServer(base) {
  for (let i = 0; i < 100; i += 1) {
    const r = await get('/api/health', base).catch(() => null);
    if (r && r.status === 200) return r.data;
    await sleep(100);
  }
  throw new Error(`server never came up on ${base}`);
}

async function main() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--db', DB], {
    cwd: ROOT,
    env: { ...process.env, LB_PORT: '', LB_DB: '', LB_TOKEN: '', LB_PENDING_DAYS: '10', LB_SWEEP_MINUTES: '60' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.on('exit', (code) => { if (code !== 0 && code !== null) console.error(`server exited early: ${code}`); });

  try {
    const health = await waitForServer(BASE);
    ok(health.ok && health.counts.messages === 0, 'health endpoint on an empty database', health);
    ok(health.pending_days === 10, 'the default grace period is ten days', health.pending_days);

    // ---------- posting creates its own targets, and marks them unassigned
    const first = await post({ channel: 'PC1', thread: 'drive health', text: 'SMART PASSED', tags: ['smart', 'ok'] });
    ok(first.status === 201, 'posting to unknown targets answers 201', first.status);
    ok(first.data.channel.created && first.data.thread.created, 'reply flags both targets as new', first.data);
    ok(first.data.channel.pending === true && first.data.thread.pending === true, 'auto-created targets are unassigned', first.data);
    ok(first.data.message.chars === 12 && first.data.message.bytes === 12, 'message length recorded', first.data.message);
    ok(JSON.stringify(first.data.message.tags) === '["ok","smart"]', 'tags stored', first.data.message.tags);

    const again = await post({ channel: 'pc1', thread: 'Drive Health', text: 'temp 36C' });
    ok(again.status === 200, 'second post reuses targets (200)', again.status);
    ok(again.data.channel.id === first.data.channel.id, 'channel names match ignoring case', again.data.channel);
    ok(again.data.thread.id === first.data.thread.id, 'thread names match ignoring case', again.data.thread);

    // a bare raw post has no target, so it falls back to default/general
    const bareRaw = await req('POST', '/api/post', undefined, { raw: 'raw body here' });
    ok(bareRaw.status === 201 && bareRaw.data.channel.name === 'default' && bareRaw.data.thread.name === 'general', 'raw post without targets uses default/general', bareRaw.data);
    ok(bareRaw.data.message.body === undefined && bareRaw.data.message.bytes === 13, 'raw body became the message', bareRaw.data.message);
    ok((await req('POST', '/api/post', undefined, { raw: '   ' })).status === 400, 'empty message rejected');
    ok((await post({ channel: 'PC1' })).status === 400, 'missing text rejected');

    const viaHeaders = await fetch(`${BASE}/api/post`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'X-Channel': 'PC1', 'X-Thread': 'update check', 'X-Tags': 'apt,pending', 'X-Source': 'cron' },
      body: 'apt shows 3 upgrades',
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    ok(viaHeaders.data.thread.name === 'update check' && viaHeaders.data.message.source === 'cron', 'headers select target, tags and source', viaHeaders.data);
    ok(viaHeaders.data.channel.id === first.data.channel.id, 'header post joins the existing channel', viaHeaders.data.channel);

    const backdated = await post({ channel: 'PC1', thread: 'drive health', text: 'old note', ts: '2020-01-02T03:04:05Z' });
    ok(backdated.data.message.ts === '2020-01-02T03:04:05.000Z', 'explicit timestamp honoured', backdated.data.message.ts);

    const empty = await post({ channel: 'PC1', thread: 'drive health', text: '   ' });
    ok(empty.status === 400, 'blank message rejected', empty.status);

    // ---------- channels and threads
    const chan = await req('POST', '/api/channels', { name: 'NAS' });
    ok(chan.status === 201 && chan.data.channel.pending === false, 'channel created as assigned', chan.data);
    ok((await req('POST', '/api/channels', { name: 'nas' })).status === 409, 'duplicate channel name rejected', 409);
    const t1 = await req('POST', '/api/threads', { channel_id: chan.data.channel.id, name: 'scrub' });
    const t2 = await req('POST', '/api/threads', { channel: 'NAS', name: 'smart' });
    ok(t1.status === 201 && t2.status === 201, 'threads created by id and by channel name', [t1.status, t2.status]);
    ok((await req('POST', '/api/threads', { channel_id: chan.data.channel.id, name: 'scrub' })).status === 409, 'duplicate thread rejected');
    ok((await req('PATCH', `/api/channels/${chan.data.channel.id}`, { name: 'NAS-box' })).data.channel.name === 'NAS-box', 'channel renamed');
    ok((await req('PATCH', `/api/threads/${t1.data.thread.id}`, { name: 'scrub status' })).data.thread.name === 'scrub status', 'thread renamed');
    const moved = await req('PATCH', `/api/threads/${t2.data.thread.id}`, { channel: 'PC1' });
    ok(moved.data.thread.channel_id === first.data.channel.id, 'thread moved between channels', moved.data.thread);

    const assignedBefore = (await get('/api/tree')).data.channels.filter((c) => !c.pending).map((c) => c.id);
    const want = [chan.data.channel.id, ...assignedBefore.filter((id) => id !== chan.data.channel.id)];
    const reordered = await req('POST', '/api/channels/reorder', { ids: want });
    const order = reordered.data.channels.filter((c) => !c.pending).map((c) => c.id);
    ok(JSON.stringify(order) === JSON.stringify(want), 'channel order persisted', { order, want });
    const tid = t1.data.thread.id;
    const t3 = await req('POST', '/api/threads', { channel_id: chan.data.channel.id, name: 'temps' });
    const tOrder = await req('POST', '/api/threads/reorder', { channel_id: chan.data.channel.id, ids: [t3.data.thread.id, tid] });
    const nasThreads = tOrder.data.channels.find((c) => c.id === chan.data.channel.id).threads.map((t) => t.id);
    ok(nasThreads[0] === t3.data.thread.id, 'thread order persisted', nasThreads);

    // ---------- search
    const sGet = (q) => get(`/api/messages?${q}`);
    ok((await sGet('q=SMART')).data.total === 1, 'substring search', (await sGet('q=SMART')).data.total);
    ok((await sGet('q=smart')).data.total === 1, 'text search ignores case by default');
    ok((await sGet('q=SMART&cs=1')).data.total === 1, 'case-sensitive search matches the uppercase one');
    ok((await sGet('q=smart&cs=1')).data.total === 0, 'case-sensitive search excludes the rest');
    ok((await sGet('q=%28unterminated&mode=regex')).status === 400, 'invalid regex → 400');
    ok(String((await sGet('q=%28unterminated&mode=regex')).data.error).includes('invalid regex'), 'regex error explained', (await sGet('q=%28unterminated&mode=regex')).data);
    ok((await sGet('q=a%7D&mode=regex')).status === 200, 'a stray brace stays a legal regex');
    ok((await sGet('q=SMART.*PASSED&mode=regex')).data.total === 1, 'regex search');
    ok((await sGet(`channel=${first.data.channel.id}&q=apt`)).data.total === 1, 'search scoped to a channel');
    ok((await sGet(`thread=${first.data.thread.id}&q=apt`)).data.total === 0, 'search scoped to a thread excludes others');
    ok((await sGet('tags=smart,ok')).data.total === 1, 'tag filter AND');
    ok((await sGet('tags=smart,apt&tag_match=any')).data.total === 2, 'tag filter OR');
    ok((await sGet('tags=smart,apt')).data.total === 0, 'tag filter AND with no overlap');
    ok((await sGet('tags=SMART')).data.total === 1, 'tag names match ignoring case');
    ok((await sGet('q=apt&from=2025-01-01&to=2026-12-31')).data.total === 1, 'date range includes a match');
    ok((await sGet('q=apt&from=2030-01-01')).data.total === 0, 'date range in the future excludes everything');
    ok((await sGet('from=2020-01-01&to=2020-12-31')).data.messages[0].body === 'old note', 'date range finds the backdated message');
    const desc = (await sGet('sort=desc&limit=3')).data.messages.map((m) => m.ts);
    const asc = (await sGet('sort=asc&limit=3')).data.messages.map((m) => m.ts);
    ok(desc[0] >= desc[1] && asc[0] <= asc[1], 'sort order honoured', { desc: desc.slice(0, 2), asc: asc.slice(0, 2) });
    const page1 = (await sGet('limit=2&offset=0')).data.messages.map((m) => m.id);
    const page2 = (await sGet('limit=2&offset=2')).data.messages.map((m) => m.id);
    ok(new Set([...page1, ...page2]).size === 4, 'paging returns disjoint pages', { page1, page2 });
    ok((await sGet('limit=99999')).data.limit === 2000, 'limit capped');

    const long = await post({ channel: 'NAS-box', thread: 'temps', text: 'q'.repeat(9000) });
    const listed = (await sGet('q=^qq&mode=regex')).data.messages.find((m) => m.id === long.data.message.id);
    ok(listed.truncated === true && listed.body.length === 8000, 'long bodies truncated in listings', [listed.truncated, listed.body.length]);
    ok((await get(`/api/messages/${long.data.message.id}`)).data.message.body.length === 9000, 'single message endpoint is untruncated');
    ok((await sGet('q=^qq&mode=regex&truncate=0')).data.messages.find((m) => m.id === long.data.message.id).body.length === 9000, 'truncate=0 disables truncation');

    // ---------- tags on messages
    const tagged = await post({ channel: 'NAS-box', thread: 'temps', text: 'tag playground', tags: ['alpha', 'beta'] });
    const mid = tagged.data.message.id;
    ok(JSON.stringify((await req('PATCH', `/api/messages/${mid}`, { add_tags: ['gamma'] })).data.message.tags).includes('gamma'), 'tag added');
    ok(!(await req('PATCH', `/api/messages/${mid}`, { remove_tags: ['beta'] })).data.message.tags.includes('beta'), 'tag removed');
    ok(JSON.stringify((await req('PATCH', `/api/messages/${mid}`, { tags: ['only'] })).data.message.tags) === '["only"]', 'tags replaced');
    ok((await req('PATCH', '/api/messages/999999', { add_tags: ['x'] })).status === 404, 'tagging an unknown message → 404');
    await req('POST', '/api/post', { channel: 'NAS-box', thread: 'temps', text: 'second beta carrier', tags: ['beta'] });
    ok((await req('POST', '/api/tags/rename', { from: 'beta', to: 'only' })).status === 200, 'tag rename into an existing tag merges');
    const tagList = (await get('/api/tags')).data.tags;
    ok(!tagList.some((t) => t.name === 'beta'), 'renamed-from tag disappears', tagList.map((t) => t.name));
    ok(tagList.find((t) => t.name === 'only').messages === 2, 'merge kept both messages under the target tag', tagList.find((t) => t.name === 'only'));
    ok((await req('DELETE', '/api/tags/only')).data.deleted === 'tag', 'tag deleted by name');
    ok((await get(`/api/messages/${mid}`)).data.message.tags.length === 0, 'deleting a tag detaches it from messages');

    // ---------- deletion and cascades
    const doomed = await post({ channel: 'temp-host', thread: 'temp-thread', text: 'doomed' });
    ok((await req('DELETE', `/api/threads/${doomed.data.thread.id}`)).data.deleted === 'thread', 'thread deleted');
    ok((await get('/api/messages?q=doomed')).data.total === 0, 'thread delete cascades to its messages');
    const doomed2 = await post({ channel: 'temp-host2', thread: 't', text: 'doomed2' });
    await req('DELETE', `/api/channels/${doomed2.data.channel.id}`);
    ok((await get('/api/messages?q=doomed2')).data.total === 0, 'channel delete cascades to messages');
    const bulk = await Promise.all([0, 1, 2].map(() => post({ channel: 'NAS-box', thread: 'temps', text: `bulk ${Math.random()}` })));
    ok((await req('POST', '/api/messages/delete', { ids: bulk.map((b) => b.data.message.id) })).data.deleted === 3, 'bulk delete');
    ok((await req('POST', '/api/messages/delete', {})).status === 400, 'bulk delete needs ids');
    ok((await req('DELETE', '/api/messages/999999')).status === 404, 'deleting an unknown message → 404');

    // ---------- read state: what one browser has seen
    // A "reader" is an anonymous per-browser id. Its first request fixes a
    // baseline, so pre-existing messages never arrive as unread.
    const RS = `reader-${process.pid}`;
    const seed = await post({ channel: 'reader-host', thread: 'reader-thread', text: 'predates the reader' });
    const rthread = seed.data.thread.id;
    ok((await rget('/api/health', RS)).data.counts.unread === 0, 'a new reader starts with nothing unread', (await rget('/api/health', RS)).data.counts);

    const landed = await post({ channel: 'reader-host', thread: 'reader-thread', text: 'landed after' });
    const rtree = (await rget('/api/tree', RS)).data;
    const rrow = rtree.channels.flatMap((c) => c.threads).find((t) => t.id === rthread);
    ok(rrow.unread === 1, 'a message that lands later is unread in the tree', rrow);
    ok(rtree.counts.unread === 1, 'the unread total counts it', rtree.counts);
    const rmsgs = (await rget(`/api/messages?thread=${rthread}`, RS)).data.messages;
    ok(
      rmsgs[0].id === landed.data.message.id && rmsgs[0].unread === true
        && rmsgs.filter((m) => m.id !== landed.data.message.id).every((m) => m.unread === false),
      'only the new message is flagged in the list', rmsgs.map((m) => [m.id, m.unread]),
    );
    ok((await rget('/api/health', `other-${process.pid}`)).data.counts.unread === 0, 'read state is per reader');
    ok((await get('/api/health')).data.counts.unread === 0, 'without a reader id nothing is reported unread');

    const marked = await rpost(`/api/reads/${rthread}`, {}, RS);
    ok(marked.data.unread === 0 && marked.data.marked === 1, 'marking a thread read reports the new count', marked.data);
    ok((await rget(`/api/messages?thread=${rthread}`, RS)).data.messages.every((m) => !m.unread), 'the thread reads as seen');
    ok((await rpost(`/api/reads/${rthread}`, { last_id: 1 }, RS)).data.unread === 0, 'a stale watermark cannot resurrect unread messages');

    await post({ channel: 'reader-host', thread: 'reader-thread', text: 'after marking' });
    ok((await rget('/api/health', RS)).data.counts.unread === 1, 'marking read does not mute future messages');

    const sideThread = await post({ channel: 'reader-host-b', thread: 'other-thread', text: 'elsewhere' });
    ok((await rget('/api/tree', RS)).data.counts.unread === 2, 'two threads now carry unread', await rget('/api/health', RS));
    const cleared = await rpost('/api/reads', { channel_id: 'reader-host' }, RS);
    ok(cleared.data.threads === 1 && cleared.data.channel_id > 0, 'mark-all scoped by channel name', cleared.data);
    const otherThread = (await rget('/api/tree', RS)).data.channels
      .flatMap((c) => c.threads).find((t) => t.name === 'other-thread');
    const byIdScope = await rpost('/api/reads', { channel_id: otherThread.channel_id }, RS);
    ok(byIdScope.data.threads >= 1, 'mark-all scoped by channel id', byIdScope.data);
    ok((await rpost('/api/reads', { channel_id: 'no-such-host' }, RS)).status === 404, 'unknown channel for mark-all → 404');
    await post({ channel: 'reader-host', thread: 'reader-thread', text: 'unread again' });
    ok((await rget('/api/health', RS)).data.counts.unread === 1, 'the other channel keeps its unread count');
    ok((await rpost('/api/reads', {}, RS)).data.marked === 1, 'mark-all clears the rest');
    ok((await rget('/api/health', RS)).data.counts.unread === 0, 'nothing unread after mark-all');

    ok((await req('POST', `/api/reads/${rthread}`)).status === 400, 'read endpoints need a reader id');
    ok((await req('POST', '/api/reads')).status === 400, 'mark-all needs a reader id');

    const vanish = await post({ channel: 'reader-host-c', thread: 'vanishing', text: 'before' });
    await post({ channel: 'reader-host-c', thread: 'vanishing', text: 'unread too' });
    ok((await rget('/api/health', RS)).data.counts.unread === 2, 'both messages of the new thread are unread');
    await req('DELETE', `/api/threads/${vanish.data.thread.id}`);
    ok((await rget('/api/health', RS)).data.counts.unread === 0, 'read state does not outlive its thread');

    // ---------- unassigned lifetime: nothing has expired yet (10 day grace)
    const stray = await post({ channel: 'stray-host', thread: 'stray-thread', text: 'nobody claimed me' });
    ok(stray.data.channel.pending === true, 'stray target starts unassigned');
    ok(stray.data.channel.expires_at > health.time, 'unassigned targets expire in the future', stray.data.channel.expires_at);
    const beforeSweep = (await get('/api/tree')).data.counts.messages;
    const swept = await req('POST', '/api/admin/sweep');
    ok(swept.data.removed.channels === 0 && swept.data.removed.threads === 0, 'nothing is swept before its grace period ends', swept.data.removed);
    ok((await get(`/api/messages/${stray.data.message.id}`)).status === 200, 'unassigned messages stay until they expire');
    ok((await get('/api/tree')).data.counts.messages === beforeSweep, 'sweep left the message count alone');
    const reposted = await post({ channel: 'stray-host', thread: 'stray-thread', text: 'again' });
    ok(reposted.data.channel.expires_at > stray.data.channel.expires_at, 'posting again slides the expiry forward', {
      first: stray.data.channel.expires_at, again: reposted.data.channel.expires_at,
    });

    // ---------- adoption
    const orphan = await post({ channel: 'orphan-host', thread: 'orphan-thread', text: 'claim me' });
    ok(orphan.data.channel.pending === true, 'orphan target starts unassigned', orphan.data.channel);
    const adoptedThread = await req('POST', `/api/threads/${orphan.data.thread.id}/adopt`);
    ok(adoptedThread.data.thread.pending === false && adoptedThread.data.thread.expires_at === null, 'adopted thread loses its expiry', adoptedThread.data.thread);
    const orphans = (await get('/api/tree')).data.channels.filter((c) => c.name === 'orphan-host');
    ok(orphans.length === 1, 'adopting a thread leaves one channel', orphans.length);
    ok(orphans[0].pending === false, 'adopting a thread adopts its channel too', orphans[0].pending);
    ok(orphans[0].threads[0].pending === false, 'the adopted thread is assigned', orphans[0].threads[0].pending);
    ok(orphans[0].messages === 1, 'adoption keeps the message', orphans[0].messages);
    ok((await req('POST', '/api/channels', { name: 'orphan-host' })).status === 409, 'the adopted name is now taken', 409);
    ok((await post({ channel: 'orphan-host', thread: 'orphan-thread', text: 'second' })).status === 200, 'later posts reuse the adopted target');

    const stray2 = await post({ channel: 'stray-host', thread: 'stray-thread', text: 'adopt by channel' });
    const adoptedChan = await req('POST', `/api/channels/${stray2.data.channel.id}/adopt`);
    ok(adoptedChan.data.channel.pending === false && adoptedChan.data.channel.expires_at === null, 'channel adopt clears the expiry', adoptedChan.data.channel);
    const strayTree = (await get('/api/tree')).data.channels.find((c) => c.id === stray2.data.channel.id);
    ok(strayTree.threads.every((t) => t.pending === false), 'channel adopt adopts its threads', strayTree.threads.map((t) => t.pending));
    const sib = await post({ channel: 'sib-host', thread: 'one', text: 'a' });
    await post({ channel: 'sib-host', thread: 'two', text: 'b' });
    const oneAdopted = await req('POST', `/api/threads/${sib.data.thread.id}/adopt`);
    ok(oneAdopted.data.thread.pending === false, 'sibling thread adopted');
    const sibTree0 = (await get('/api/tree')).data.channels.find((c) => c.id === sib.data.channel.id);
    ok(sibTree0.pending === false, 'adopting a thread claims its unassigned channel', sibTree0.pending);
    const retargeted = await post({ channel: 'sib-host', thread: 'two', text: 'b2' });
    ok(retargeted.data.thread.id === sibTree0.threads.find((t) => t.pending).id, 'posting again reuses the pending sibling', retargeted.data.thread);
    const pendingSib = sibTree0.threads.find((t) => t.pending);
    // adopting the last pending thread leaves nothing pending in that channel
    const lastThread = sibTree0.threads.find((t) => t.pending).id;
    await req('POST', `/api/threads/${lastThread}/adopt`);
    const sibTree1 = (await get('/api/tree')).data.channels.find((c) => c.id === sib.data.channel.id);
    ok(sibTree1.threads.every((t) => !t.pending), 'channel fully claimed after all threads adopted', sibTree1.threads.map((t) => t.pending));

    // adopting a channel claims every thread it collected
    const multi = await post({ channel: 'multi-host', thread: 'a', text: '1' });
    await post({ channel: 'multi-host', thread: 'b', text: '2' });
    const multiChan = await req('POST', `/api/channels/${multi.data.channel.id}/adopt`);
    ok(multiChan.data.channel.pending === false, 'channel adopted');
    const multiTree = (await get('/api/tree')).data.channels.find((c) => c.id === multi.data.channel.id);
    ok(multiTree.threads.every((t) => !t.pending), 'channel adoption claims its threads too', multiTree.threads.map((t) => t.pending));


    // ---------- unassigned channels disappear entirely
    const doomedPending = await post({ channel: 'doomed-host', thread: 'd', text: 'x' });
    const discarded = await req('DELETE', `/api/channels/${doomedPending.data.channel.id}`);
    ok(discarded.data.deleted === 'channel', 'pending channel can be discarded directly');
    ok((await get(`/api/messages/${doomedPending.data.message.id}`)).status === 404, 'discarding a channel deletes its messages');

    // ---------- misc contract details
    ok((await get('/api/nope')).status === 404, 'unknown route → 404');
    for (const v of ['/vendor/marked.min.js', '/vendor/purify.min.js']) {
      const res = await fetch(BASE + v);
      const body = await res.text();
      ok(res.status === 200 && /javascript/.test(res.headers.get('content-type') || ''), `${v} served as javascript`, res.headers.get('content-type'));
      ok(body.length > 10_000, `${v} is a real library, not a stub`, body.length);
    }
    ok((await req('POST', '/api/channels', { name: '' })).status === 400, 'empty channel name → 400');
    ok((await req('POST', '/api/channels', { name: 'a/b' })).status === 400, 'illegal character in name → 400');
    ok((await req('POST', '/api/threads', { channel_id: 999999, name: 'x' })).status === 404, 'thread in unknown channel → 404');
    const tree = (await get('/api/tree')).data;
    ok(tree.counts.messages === tree.channels.reduce((n, c) => n + c.messages, 0), 'tree counts agree with per-channel counts', tree.counts);
    ok(tree.channels.every((c) => c.pending || c.expires_at === null), 'assigned channels carry no expiry');
    const home2 = (await get('/api/health')).data;
    ok(home2.counts.messages > 0 && home2.counts.threads > 0, 'health counters move with the data', home2.counts);
    // ---------- token enforcement, on a second instance
  {
    const tPort = PORT + 1;
    const tBase = `http://127.0.0.1:${tPort}`;
    const tDb = `${DB}.token`;
    const guard = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(tPort), '--db', tDb, '--token', 'hunter2'], {
      cwd: ROOT,
      env: { ...process.env, LB_PORT: '', LB_DB: '', LB_TOKEN: '', LB_PENDING_DAYS: '10' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
      const tHealth = await waitForServer(tBase);
      ok(tHealth.auth === true, 'health advertises that a token is required', tHealth);
      ok((await get('/api/tree', tBase)).status === 200, 'reads allowed without a token');
      ok((await req('POST', '/api/post', { channel: 'a', thread: 'b', text: 'x' }, { base: tBase })).status === 401, 'write without a token → 401');
      ok((await req('POST', '/api/post', { channel: 'a', thread: 'b', text: 'x' }, { base: tBase, token: 'nope' })).status === 401, 'wrong token → 401');
      ok((await req('POST', '/api/post', { channel: 'a', thread: 'b', text: 'x' }, { base: tBase, token: 'hunter2' })).status === 201, 'correct token accepted');
      ok((await req('DELETE', '/api/channels/1', undefined, { base: tBase })).status === 401, 'delete without a token → 401');
      ok((await fetch(`${tBase}/api/channels/1`, { method: 'DELETE' })).status === 401, 'delete rejected even with the token in neither header nor query');
      ok((await (await fetch(`${tBase}/api/channels?token=hunter2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'TokenChan' }) })).status) === 201, 'token via query param accepted');
      ok((await get('/api/settings', tBase)).status === 200, 'settings readable without a token');
      ok((await req('POST', '/api/settings', { retention_days: 30 }, { base: tBase })).status === 401, 'changing settings needs the token');
    } finally {
      guard.kill('SIGTERM');
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(tDb + suffix, { force: true }); } catch { /* ignore */ }
      }
    }

    // ---------- real expiry: a server whose grace period has already elapsed
    {
      const ePort = PORT + 2;
      const eBase = `http://127.0.0.1:${ePort}`;
      const eDb = `${DB}.expiry`;
      const burner = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(ePort), '--db', eDb, '--pending-days', '0', '--sweep-minutes', '600'], {
        cwd: ROOT,
        env: { ...process.env, LB_PORT: '', LB_DB: '', LB_TOKEN: '', LB_PENDING_DAYS: '', LB_SWEEP_MINUTES: '' },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      try {
        await waitForServer(eBase);
        const keeper = await req('POST', '/api/channels', { name: 'keeper' }, { base: eBase });
        const keeperThread = await req('POST', '/api/threads', { channel_id: keeper.data.channel.id, name: 't' }, { base: eBase });
        ok(keeperThread.data.thread.pending === false, 'a thread created through the API is assigned', keeperThread.data.thread.pending);
        await post({ channel: 'keeper', thread: 't', text: 'assigned stays' }, { base: eBase });
        const ghost = await post({ channel: 'ghost-host', thread: 'g', text: 'expired' }, { base: eBase });
        ok(ghost.data.channel.pending === true, 'expired-grace server still marks new targets unassigned');
        // a plain read must not be what deletes the row
        const readBack = await get(`/api/messages/${ghost.data.message.id}`, eBase);
        ok(readBack.status === 200, 'reading a message does not delete it');
        const removed = await req('POST', '/api/admin/sweep', undefined, { base: eBase });
        ok(removed.data.removed.channels >= 1, 'expiry sweep removes the unclaimed channel', removed.data.removed);
        ok((await get(`/api/messages/${ghost.data.message.id}`, eBase)).status === 404, 'expired unassigned message is gone');
        ok((await get('/api/messages?q=assigned', eBase)).data.total === 1, 'assigned-channel messages survive the sweep');
        ok(keeper.status === 201, 'keeper channel still there');
      } finally {
        burner.kill('SIGTERM');
        for (const suffix of ['', '-wal', '-shm']) {
          try { fs.rmSync(eDb + suffix, { force: true }); } catch { /* ignore */ }
        }
      }
    }

    // ---------- server settings: retention + board size counters
    {
      const h0 = (await get('/api/health')).data;
      ok(h0.retention_days === 0, 'retention is off by default — keep everything', h0.retention_days);
      ok(h0.counts.bytes > 0, 'health reports the stored message bytes', h0.counts);
      ok(h0.db_bytes >= h0.counts.bytes, 'health reports the db file size', h0.db_bytes);
      const s0 = (await get('/api/settings')).data.settings;
      ok(s0.retention_days === 0, 'settings default to keep-everything', s0);
      ok((await req('POST', '/api/settings', { retention_days: -2 })).status === 400, 'negative retention → 400');
      ok((await req('POST', '/api/settings', { retention_days: 'soon' })).status === 400, 'non-numeric retention → 400');
      ok((await req('POST', '/api/settings', {})).status === 400, 'missing retention_days → 400');
      ok((await req('POST', '/api/settings', { retention_days: 45 })).status === 200, 'retention saved');
      ok((await get('/api/settings')).data.settings.retention_days === 45, 'retention persisted');
      const stale = await post({ channel: 'retention', thread: 'age', text: 'ancient log', ts: '-90d' });
      const fresh = await post({ channel: 'retention', thread: 'age', text: 'current log' });
      ok(stale.status === 201, 'backdated message accepted');
      const swept = (await req('POST', '/api/admin/sweep')).data;
      ok(swept.removed.messages >= 1, 'the sweep deletes messages past the cutoff', swept.removed);
      ok((await get(`/api/messages/${stale.data.message.id}`)).status === 404, 'the old message is gone');
      ok((await get(`/api/messages/${fresh.data.message.id}`)).status === 200, 'messages inside the window survive');
      const stillThere = (await get('/api/messages?channel=retention')).data;
      ok(stillThere.total === 1, 'the thread survives with its young messages', stillThere.total);
      ok((await req('POST', '/api/settings', { retention_days: 0 })).status === 200, 'retention can be turned off again');
      const stale2 = await post({ channel: 'retention', thread: 'age', text: 'kept ancient log', ts: '-90d' });
      await req('POST', '/api/admin/sweep');
      ok((await get(`/api/messages/${stale2.data.message.id}`)).status === 200, 'with retention off nothing expires');
    }
  }
  } finally {
    child.kill('SIGTERM');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
    }
  }

  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke test harness error:', err);
  process.exit(2);
});
