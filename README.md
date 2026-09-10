# message_viewer

A small, self-hosted board for logs and messages that your scripts post from
different machines.

```
channel "PC1"
  └── thread "drive health"
        ├── 2026-09-09 21:44:02 · 56 chars · #1  [smart] [ok]
        │     SMART overall-health self-assessment test result: PASSED
        └── 2026-09-09 21:45:10 · 38 chars · #4  [smart]
              Reallocated_Sector_Ct 0  Temperature 36C
```

* **channels** group **threads**, threads collect **messages** over time
* every message stores its own timestamp and length and is shown as a separate card
* any message can carry any number of free-form **tags**
* messages render as **markdown** on demand — for the whole board or one card
* search everything, or just one thread / one channel — plain text or regex,
  filterable by tag and date range
* channels and threads are created, renamed, reordered, moved and deleted in the UI
* anything you have not looked at yet is marked **unread** — per browser, no accounts (§4)
* dark and light theme, following the operating system until you pick one
* an optional timer keeps the whole board fresh while the page sits open
* the server can delete messages older than a retention window you set —
  off by default, everything is kept forever
* messages are only deletable and taggable — the text itself is immutable (it is a log)
* posting to a channel or thread that does not exist works: the target is created as
  **unassigned** and kept for 10 days unless you adopt it
* storage is one SQLite file, no daemons besides this one, no accounts, no internet needed

Stack: Node 20+, Express 5, better-sqlite3, vanilla JS/HTML/CSS front-end (no build step;
the markdown renderer and HTML sanitizer are npm packages served straight from
`node_modules` at `/vendor`).

## 1. Run it

```sh
cd /root/message_viewer
npm install          # express + better-sqlite3
npm test             # optional: contract checks against a throwaway database
npm start            # → http://<this machine>:8421
```

`npm install` compiles nothing by hand: `better-sqlite3` ships prebuilt binaries.
Node must be 20 or newer (`node --version`).

The database is created on first start at `./data/messages.db`.

### Options

Command line flags win over environment variables.

| flag | env | default | meaning |
|---|---|---|---|
| `--port` | `MV_PORT` | `8421` | listen port |
| `--host` | `MV_HOST` | `0.0.0.0` | bind address (`127.0.0.1` = this machine only) |
| `--db` | `MV_DB` | `./data/messages.db` | SQLite file |
| `--token` | `MV_TOKEN` | *(empty)* | shared secret needed to write (see §6) |
| `--pending-days` | `MV_PENDING_DAYS` | `10` | how long unassigned channels/threads survive |
| `--max-body` | `MV_MAX_BODY` | `8mb` | largest single posted message |
| `--sweep-minutes` | `MV_SWEEP_MINUTES` | `15` | how often expired targets are swept |
| `--retention-days` | `MV_RETENTION_DAYS` | `0` | initial retention window; `0` keeps everything — ⚙ settings overrides it from then on (it lives in the db) |

Nothing in the browser talks to the server that is not in §5. Browser-local things —
the theme, the refresh interval, the markdown toggle, the write token, the sidebar
expansion and the reader id — live in that browser's `localStorage` only. Anything
that changes what the board itself does, like the retention window, is stored in the
database and edited in ⚙ settings.

```sh
node server.js --port 9000 --db /var/lib/message_viewer/messages.db --token s3cret
```

### Keep it running with systemd

```sh
cp -r . /opt/message_viewer && cd /opt/message_viewer && npm install
cp deploy/message-viewer.service /etc/systemd/system/
editor /etc/systemd/system/message-viewer.service   # set MV_TOKEN, paths
systemctl daemon-reload
systemctl enable --now message-viewer
journalctl -u message-viewer -f
```

## 2. Post from a script

The posting endpoint is one `POST` with the channel, thread and tags named in the
request. Missing targets are created for you, so a script never has to register first.

```sh
curl -X POST http://message-host:8421/api/post \
  -H 'content-type: application/json' \
  -d '{"channel":"PC1","thread":"drive health","tags":["smart","ok"],
       "text":"SMART overall-health self-assessment test result: PASSED"}'
```

Raw text works too — target in headers, body is the message:

```sh
smartctl -a /dev/sda | curl -X POST --data-binary @- http://message-host:8421/api/post \
  -H 'content-type: text/plain' -H 'X-Channel: PC1' -H 'X-Thread: drive health' -H 'X-Tags: smart'
```

### `bin/mv-post`

A POSIX shell wrapper (uses `curl`, optional `python3` for JSON quoting) so cron
jobs and `|| mv-post ...` traps stay short:

```sh
export MV_URL=http://message-host:8421          # default http://127.0.0.1:8421
export MV_TOKEN=...                             # only if the server sets MV_TOKEN

mv-post -c PC1 -t "drive health" -T smart -m "temperature 36C"
echo "3 packages can be upgraded" | mv-post -c PC1 -t "update check" -T apt -T pending
mv-post -c server7 -t backup -T zfs -f /var/log/backup-last-run.log
mv-post -c NAS -t scrub -T error -q -m "scrub stopped with errors"   # -q: stay silent
mv-post -c PC1 -t "drive health" --ts 2026-09-01T08:00:00Z -m "backdated note"
mv-post --help
```

`--tag` is repeatable, text comes from `--message`, `--file`, or stdin, and the
host name is recorded as the message source. New targets are reported:

```
posted #17 -> laptop9/battery report  26 chars  (NEW channel+thread — unassigned, expires 2026-09-20T01:02:11.510Z)
```

Real cron line, one per machine:

```cron
@daily smartctl -H /dev/sda | mv-post -c "$(hostname -s)" -t "drive health" -T smart
@weekly apt list --upgradable 2>/dev/null | mv-post -c "$(hostname -s)" -t "update check" -T apt
@monthly zpool status tank | mv-post -c nas -t scrub -T zfs || mv-post -c nas -t scrub -T zfs -T error -m "zpool status failed"
```

### `POST /api/post` fields

| field | aliases | default | notes |
|---|---|---|---|
| `channel` | `chan`, `c`, header `X-Channel`, `?channel=` | `default` | created if unknown |
| `thread` | `topic`, `t`, header `X-Thread`, `?thread=` | `general` | created if unknown |
| `text` | `body`, `message`, `msg`, `log` | — (required in JSON) | with a raw body the whole payload is the text |
| `tags` | `tag`, header `X-Tags`, `?tags=` | — | array, or `"a,b"`, or `"a b"`; leading `#` stripped |
| `ts` | `timestamp`, `time`, header `X-Ts`, `?ts=` | now | ISO-8601, `YYYY-MM-DD HH:MM:SS`, or epoch seconds |
| `source` | `host`, `from`, header `X-Source` | — | free-form label shown in the UI |

Names match case-insensitively, so `pc1` and `PC1` are one channel. The reply
confirms ids, length, tags, and whether the targets were new:

```json
{ "ok": true,
  "message": { "id": 42, "ts": "2026-09-10T01:02:11.510Z", "chars": 26, "bytes": 26,
               "tags": ["smart"], "source": "cron@PC1" },
  "channel": { "id": 5, "name": "PC1", "pending": false, "created": false, "expires_at": null },
  "thread":  { "id": 7, "channel_id": 5, "name": "drive health", "pending": false, "created": false }
```

`201` means a channel or thread was created, `200` that everything already existed.

## 3. Unassigned targets

Scripts make typos, and new machines appear. A post for an unknown target creates it
under **Unassigned** in the sidebar instead of failing, and it is kept for
`MV_PENDING_DAYS` (default 10). Every post to it restarts that clock, so a chatty
mistake does not expire mid-flight.

* ✔ **adopt** — the target becomes real, keeps its messages, and merges into an
  existing same-named target if there is one. Adopting a *channel* adopts every thread
  it collected; adopting a *thread* claims that thread and its channel but leaves
  sibling threads unassigned for you to judge separately
* ✖ **discard** — the target and everything inside it is deleted now
* nothing happens — expired targets and their messages are deleted by a sweep. It runs
  at startup, every `MV_SWEEP_MINUTES`, and lazily while the sidebar refreshes (at most
  once every 30 s), so an expired row never lingers in Unassigned. Reads never delete
  anything outside that rate limit.

Creating or adopting a channel named `PC1` while an unassigned `PC1` exists adopts it,
so the usual "I meant to create that channel" case is one click and never loses messages.

## 4. The web UI

Open `http://<this machine>:8421`.

**Sidebar** — channels, each expandable into its threads with the `▸` / `▾` button.
`⋮⋮` drags a channel or a thread into a new position (threads reorder inside their own
channel). Hover a row for its actions: `＋` add thread, `✎` rename, `⇄` move thread to
another channel, `🗑` delete. The row you are looking at is tinted and marked with an
accent bar. Above the channels sits **Unassigned** (§3); at the bottom, a `curl`
example for the channel or thread you are looking at.

**Message list** — newest first. Each card header carries the timestamp, id, channel /
thread, length (`56 chars · 56 B`), and the posting source. Long bodies collapse; a
message too big for the list gets a **load full text** link.

**Markdown** — the `md` button in the filter row renders message bodies as
GitHub-flavoured markdown (headings, tables, task lists, fenced code, links;
bare newlines stay line breaks, which is what log text wants). The choice is
remembered per browser and the raw log view stays the default. Every card also
has its own `md` button that overrides the global setting for just that
message; touching the global button clears those one-off choices. Rendering
happens in the browser: `marked` turns the text into HTML, `DOMPurify` strips
everything hostile from it (bodies are posted by scripts and treated as
untrusted input), and both libraries are vendored npm packages served from
`/vendor` — still no build step and no internet needed.

**Searching** — type in the box (`/` focuses it):

* `text` mode is a substring match, `regex` mode is a JavaScript regular expression;
  `Aa` toggles case sensitivity
* scope: click a channel or a thread in the sidebar; the crumbs line shows the scope,
  and `✕ scope` returns to everything. Views are plain URLs (`#/thread/12`), so they
  can be bookmarked
* `tags:` opens a picker with counts; `ALL` requires every selected tag, `ANY` at least one
* `from`/`to` date inputs, or a quick `last hour`/`24h`/`7 days`/`30 days` preset
* sort order, page size (50–500) and prev/next paging

Matches are highlighted in place.

**Staying fresh** — the `refresh:` select in the filter row reloads the board on a
timer: `off`, 5 s … 15 min, 1 h. ⚙ settings takes any exact number of seconds instead,
and both controls show the same value; the choice is remembered per browser.

A tick reloads *everything* — the sidebar with its counts and unread badges, the
unassigned panel and the message list (the tag picker is refreshed on
each tick while it is open, and once when you open it) — so a message posted to a channel you are not looking at shows
up there too, without you doing anything. The list
keeps your scroll position, and the timer pauses while the tab is hidden (returning to
it refreshes at once) and while you are dragging a channel or thread.

**Theme** — `☀` / `☾` in the top left switches between light and dark. Until you touch
it the page follows the operating system, and your choice is remembered per browser.
Every colour in the app is a CSS custom property, re-declared under
`:root[data-theme="light"]` in `public/style.css`; both palettes are contrast-checked
against WCAG in the UI test harness.

**Unread** — read state is per browser: on its first request a browser gets an anonymous
reader id (stored in `localStorage`, sent as `x-reader`), and everything already on the
board counts as seen. After that:

* a message that arrives in a thread you have not opened makes that thread and its
  channel show an orange **count badge**, and the tab title reads `(3) message_viewer`
* open such a thread and its unseen cards stay marked — an orange rule plus a `●` —
  and anything that lands *while you are watching* gets a stronger **NEW** pill
* **clicking away is what marks the thread as seen**; closing the tab counts too.
  Channel and all-messages views only show markers, they never mark anything read
* the crumbs line offers `mark N read` to clear the current scope by hand

The id is deliberately anonymous: it only says *this browser has read up to here*. A
watermark never moves backwards, so a message cannot silently become unread again —
only a message that arrives later can raise the count. Deleting a thread drops its
read state with it.

**Message actions** — `delete`, plus tags: click a tag to filter by it, its `×` to
remove it from that message, `+ tag` to add one (any new tag name is created).
Tick boxes select several messages for a bulk delete. Use ⚙ settings to store a
`MV_TOKEN` if the server needs one.

**Retention & size** — ⚙ settings carries one server-wide switch: *delete
messages older than N days*, with `0` meaning keep everything. It lives in the
database (not in a browser), applies to every reader, needs the write token to
change, and is enforced by the same sweep that handles unassigned expiry (§3) —
at startup, every `MV_SWEEP_MINUTES`, and lazily while the sidebar refreshes.
The line under the sidebar header counts the board: message, channel, thread
and tag totals, the bytes of stored message bodies, and the sqlite file size —
so you can watch what the logs actually cost.

## 5. HTTP API

Reads need no token; every write needs one when `MV_TOKEN` is set — except the read-state
endpoints, which only move that browser's own view of the board and so need an `x-reader`
id instead of a token. Send `x-reader: <id>` on any read to have `unread` filled in;
without it every `unread` is `0`/`false`.

| method + path | body / query | effect |
|---|---|---|
| `GET /api/health` | — | version, time, `pending_days`, `retention_days`, counters, `db_bytes`, `counts.unread` (`counts.bytes` = stored message payload, `db_bytes` = the sqlite file with its WAL) |
| `GET /api/tree` | — | channels → threads, with counts, `pending`, `expires_at`, `unread` per thread and channel |
| `GET /api/tags` | — | tags with message counts |
| `GET /api/messages` | `q`, `mode`, `cs`, `channel`, `thread`, `tags`, `tag_match`, `from`, `to`, `sort`, `limit`≤2000, `offset`, `truncate` | search; `truncate=0` returns whole bodies, default caps each at 8000 chars and sets `truncated`; each row carries `unread` |
| `GET /api/messages/:id` | — | one message, untruncated |
| `POST /api/post` | §2 | post a message |
| `POST /api/channels` | `{"name":"NAS"}` | create channel — adopts an unassigned one of that name |
| `PATCH /api/channels/:id` | `{"name":"NAS-box"}` | rename |
| `POST /api/channels/reorder` | `{"ids":[3,1,2]}` | new channel order |
| `POST /api/channels/:id/adopt` | — | make an unassigned channel real (adopting children too) |
| `DELETE /api/channels/:id` | — | delete channel, threads and messages |
| `POST /api/threads` | `{"channel_id":3,"name":"scrub"}` or `{"channel":"NAS",...}` | create thread |
| `PATCH /api/threads/:id` | `{"name":"scrub status"}`, `{"channel_id":5}` or `{"channel":"NAS"}` | rename / move |
| `POST /api/threads/reorder` | `{"channel_id":3,"ids":[7,4]}` | new thread order |
| `POST /api/threads/:id/adopt` | — | make an unassigned thread real |
| `DELETE /api/threads/:id` | — | delete thread and its messages |
| `PATCH /api/messages/:id` | `{"add_tags":[...],"remove_tags":[...],"tags":[...]}` | tags only — text is immutable |
| `DELETE /api/messages/:id` · `POST /api/messages/delete` | `{"ids":[1,2,3]}` | delete one / several |
| `POST /api/tags/rename` | `{"from":"warn","to":"warning"}` | rename, merging into `to` if it exists |
| `DELETE /api/tags/:idOrName` | — | detach tag everywhere and drop it |
| `POST /api/admin/sweep` | — | delete expired unassigned targets now; also enforces the retention window |
| `POST /api/reads/:thread_id` | `last_id` (optional) | mark that thread seen up to `last_id` (default: newest) → `{"thread_id","marked","unread"}` |
| `POST /api/reads` | `channel_id` = id or name (optional) | mark a whole channel, or the board, seen → `{"threads","marked"}` |
| `GET /api/settings` | — | the server-wide settings: `{"retention_days":N}`, `0` = keep everything |
| `POST /api/settings` | `{"retention_days":N}` | token-gated; enabling it deletes everything older right away |

Errors come back as `{"ok":false,"error":"…"}` with 400 (bad input, invalid regex, or a
read endpoint without an `x-reader` id), 401 (token), 404 (unknown id/name) or 409 (name in use).

Search examples:

```sh
# everything mentioning SMART, newest first
curl 'localhost:8421/api/messages?q=SMART'

# regex, inside one channel, only messages tagged zfs and error, last 7 days
curl -G localhost:8421/api/messages \
  --data-urlencode 'q=scrub.*(error|fail)' -d mode=regex \
  -d channel=NAS -d tags=zfs,error -d tag_match=all -d from=-7d

# every message of one thread, oldest first, unpaginated
curl -G localhost:8421/api/messages -d thread=1 -d sort=asc -d limit=2000 -d truncate=0
```

## 6. Security notes

Nothing here authenticates users: whoever can reach the port can read everything and —
unless you set `MV_TOKEN` — write too. It is meant for a trusted LAN or a tunnel.

* `MV_TOKEN` gates every write (`-H 'x-post-token: …'`, `Authorization: Bearer …`, or
  `?token=`). Reads are never gated: the token decides who may post and edit, while
  everyone who can reach the port can read the messages. Set it if posting rights matter.
* `MV_HOST=127.0.0.1` plus an SSH tunnel (`ssh -L 8421:localhost:8421 host`) keeps it
  off the network entirely; `MV_HOST=0.0.0.0` (default) serves the whole LAN —
  the startup log says so explicitly.
* One shared token is the whole design; per-machine keys or TLS termination are jobs
  for a reverse proxy (nginx/caddy) in front of it.
* The SQLite file *is* the database — back it up with `sqlite3 data/messages.db ".backup backup.db"`
  or stop the server and copy `messages.db*`.
* Message bodies are untrusted input: the markdown view renders them through
  DOMPurify, so scripts, event handlers and `javascript:` links do not survive;
  the raw view is plain text either way.

## 7. Layout

```
server.js                     HTTP API, static UI, sweeps
lib/db.js                     schema, search, ordering, adopt/merge, expiry, read state
public/index.html|app.js|markdown.js|style.css
                              front-end (no framework, no build); markdown.js wraps
                              marked + DOMPurify, served by this app at /vendor;
                              style.css holds both theme palettes as CSS variables
bin/mv-post                   POSIX shell posting helper
test/smoke.mjs                `npm test` — contract checks, boots its own servers
deploy/message-viewer.service systemd unit
data/messages.db              the database (gitignored)
```

## 8. Troubleshooting

| symptom | cause / fix |
|---|---|
| `EADDRINUSE` on start | another process owns the port → `--port` |
| `better-sqlite3` build errors on install | Node too old, or no prebuilt binary for it → use Node 20+ |
| posted message invisible | it went to an **unassigned** target — check the Unassigned panel and adopt it |
| old messages vanished on their own | an unassigned target expired (§3); adopt anything you want to keep |
| old messages vanish on a schedule | retention is on — ⚙ settings holds the window (it is a server setting; another browser is not deleting them) |
| `401 bad or missing token` | server runs with `MV_TOKEN`; send the header or set the token in ⚙ settings |
| `413 body too large` | raise `--max-body` |
| `400 invalid regex: …` | the pattern is not a valid JavaScript regex |
| empty UI after a move/rename | the row is under another channel — the sidebar auto-expands the channel of the open thread |
