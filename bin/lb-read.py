#!/usr/bin/env python3
"""lb-read.py — read messages back from a logboard.

The same filters the web UI has, as plain arguments:

  lb-read.py -c "channel 1" -t "thread 1" --days 7     # the usual case
  lb-read.py -c PC1 -t "drive health"                  # newest 100 of a thread
  lb-read.py -c PC1 --days 7 -T error --tag-match any
  lb-read.py -q "SMART.*FAIL" --regex -c NAS
  lb-read.py -c NAS --raw | grep -i fail               # bodies only
  lb-read.py --json --days 1 | jq '.messages[].body'  # machine-readable
  lb-read.py --list                                    # what can be read
  lb-read.py -c NAS -t backup --days 7 --save ./logs  # files under logs/NAS/backup/

--list prints every channel and thread with its message count, so you can
see what exists before reading it. --save writes each message body to a
file under DIR/<channel>/<thread>/, named by message time and id.

env: LB_URL (default http://127.0.0.1:8421). Reads need no token.

Exit codes: 0 ok · 1 server rejected / unreachable · 2 bad usage.
Uses only the Python standard library.
"""

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8421"


def parse_args(argv):
    ap = argparse.ArgumentParser(
        prog="lb-read.py",
        description=__doc__.splitlines()[0],
        epilog=(
            "--from/--to accept ISO-8601, \"YYYY-MM-DD HH:MM:SS\", or epoch\n"
            "seconds; --days N is shorthand for --from <now - N days>. Names\n"
            "match case-insensitively. Timestamps print in UTC."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("-c", "--channel", metavar="NAME", help="scope to one channel")
    ap.add_argument("-t", "--thread", metavar="NAME",
                    help="scope to one thread (channel optional)")
    ap.add_argument("-q", "--query", metavar="TEXT",
                    help="substring match (or regex with --regex)")
    ap.add_argument("--regex", action="store_true",
                    help="treat --query as a JavaScript regular expression")
    ap.add_argument("--case-sensitive", action="store_true",
                    help="make --query case sensitive")
    ap.add_argument("-T", "--tag", action="append", default=[], metavar="TAG",
                    help="require a tag (repeatable, commas split too)")
    ap.add_argument("--tag-match", choices=("all", "any"), default="all",
                    help="ALL tags (default) or ANY of the -T tags")
    ap.add_argument("--from", dest="from_", metavar="WHEN", help="oldest timestamp")
    ap.add_argument("--to", metavar="WHEN", help="newest timestamp")
    ap.add_argument("--days", type=float, metavar="N",
                    help="only messages at most N days old")
    ap.add_argument("--sort", choices=("desc", "asc"), default="desc",
                    help="newest first (default) or oldest first")
    ap.add_argument("--limit", type=int, default=100, metavar="N",
                    help="page size, max 2000 (default: 100)")
    ap.add_argument("--offset", type=int, default=0, metavar="N",
                    help="skip the first N matches (paging)")
    ap.add_argument("--full", action="store_true",
                    help="whole bodies (the server truncates at 8000 chars by default)")
    ap.add_argument("--raw", action="store_true",
                    help="print message bodies only, no headers")
    ap.add_argument("--json", action="store_true",
                    help="print the raw API reply as JSON")
    ap.add_argument("--list", action="store_true",
                    help="list channels and threads with message counts, then exit")
    ap.add_argument("--save", metavar="DIR",
                    help="write each body to DIR/<channel>/<thread>/<time>-<id>.txt, "
                         "creating directories as needed (whole bodies, idempotent)")
    ap.add_argument("-u", "--url", default=os.environ.get("LB_URL") or DEFAULT_URL,
                    metavar="URL", help=f"server base URL (default: $LB_URL or {DEFAULT_URL})")
    ap.add_argument("--timeout", type=float, default=15.0, metavar="SECS",
                    help="per-request HTTP timeout (default: 15)")
    ap.add_argument("-r", "--retries", type=int, default=2, metavar="N",
                    help="retries on network errors and 5x (default: 2)")
    args = ap.parse_args(argv)

    tags = [t.strip().lstrip("#") for spec in args.tag for t in spec.split(",")]
    args.tags = [t for t in tags if t]
    args.url = args.url.rstrip("/")
    return args


class ReadError(Exception):
    pass


class UsageError(Exception):
    pass


def get(args, path, params=None):
    """GET a JSON endpoint; returns parsed json or raises ReadError."""
    url = args.url + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="GET")
    last = "no response"
    for attempt in range(args.retries + 1):
        if attempt:
            time.sleep(min(2 ** attempt, 10) * 0.5)
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(body).get("error") or body.strip()
            except (ValueError, AttributeError):
                detail = body.strip() or err.reason
            if err.code < 500:
                raise ReadError(f"HTTP {err.code}: {detail}") from None
            last = f"HTTP {err.code}: {detail}"
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as err:
            last = str(getattr(err, "reason", err)) or err.__class__.__name__
    raise ReadError(f"could not reach {url}: {last}")


def message_params(args):
    params = {
        "sort": args.sort,
        "limit": min(max(args.limit, 1), 2000),
        "offset": max(args.offset, 0),
        "tag_match": args.tag_match,
    }
    if args.channel:
        params["channel"] = args.channel
    if args.thread:
        params["thread"] = args.thread
    if args.query:
        params["q"] = args.query
        if args.regex:
            params["mode"] = "regex"
        if args.case_sensitive:
            params["cs"] = "1"
    if args.tags:
        params["tags"] = ",".join(args.tags)
    frm, to = args.from_, args.to
    if args.days is not None:
        if frm:
            raise UsageError("--days and --from are mutually exclusive")
        frm = (datetime.datetime.now(datetime.timezone.utc)
               - datetime.timedelta(days=args.days)).isoformat()
    if frm:
        params["from"] = frm
    if to:
        params["to"] = to
    if args.full or args.save:
        params["truncate"] = 0
    return params


def fmt_ts(iso):
    # "2026-10-11T08:24:35.000Z" -> "2026-10-11 08:24:35"
    return iso[:19].replace("T", " ") if iso else iso


def print_tree(args):
    d = get(args, "/api/tree")
    if args.json:
        json.dump(d, sys.stdout, indent=1)
        print()
        return 0
    for c in d["channels"]:
        mark = " (unassigned)" if c["pending"] else ""
        print(f'{c["name"]}{mark}  {c["messages"]} msg')
        for t in c["threads"]:
            tmark = " (unassigned)" if t["pending"] else ""
            print(f'  {t["name"]}{tmark}  {t["messages"]} msg')
    return 0


def print_messages(args, d):
    if args.json:
        json.dump(d, sys.stdout, indent=1)
        print()
        return 0
    for m in d["messages"]:
        if not args.raw:
            tags = f'  [{", ".join(m["tags"])}]' if m["tags"] else ""
            src = f'  ({m["source"]})' if m.get("source") else ""
            print(f'#{m["id"]}  {fmt_ts(m["ts"])}  {m["channel"]}/{m["thread"]}{src}{tags}')
        body = m["body"]
        sys.stdout.write(body if body.endswith("\n") or not body else body + "\n")
        if m.get("truncated") and not args.raw:
            print("… [truncated — use --full for the whole body]")
        if not args.raw:
            print()
    shown = len(d["messages"])
    if not args.raw:
        note = f", showing {shown}" if shown != d["total"] else ""
        print(f'{d["total"]} match(es){note}', file=sys.stderr)
    return 0


def safe_name(name):
    """Filesystem-safe directory name from a channel or thread name."""
    cleaned = "".join(c if c not in '/\\:*?"<>|' and ord(c) >= 32 else "_" for c in name)
    return cleaned.strip(" .") or "unnamed"


def save_messages(args, d):
    """One file per message: DIR/channel/thread/YYYYMMDDTHHMMSSZ-id.txt.

    The directory tree mirrors the board; re-running overwrites the same
    files instead of duplicating them. Bodies are written whole."""
    if args.json:
        json.dump(d, sys.stdout, indent=1)
        print()
    for m in d["messages"]:
        stamp = m["ts"][:19].replace("-", "").replace(":", "") + "Z"
        rel = os.path.join(safe_name(m["channel"]), safe_name(m["thread"]))
        name = f'{stamp}-{m["id"]}.txt'
        path = os.path.join(args.save, rel, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(m["body"])
        if not args.json:
            print(os.path.join(rel, name))
    if not args.json and not args.raw:
        saved = len(d["messages"])
        note = f", saved {saved}" if saved != d["total"] else ""
        print(f'{d["total"]} match(es){note}', file=sys.stderr)
    return 0


def main(argv=None):
    args = parse_args(argv)
    if args.retries < 0:
        print("lb-read.py: --retries must be >= 0", file=sys.stderr)
        return 2
    try:
        if args.list:
            return print_tree(args)
        params = message_params(args)
    except UsageError as err:
        print(f"lb-read.py: {err}", file=sys.stderr)
        return 2
    try:
        d = get(args, "/api/messages", params)
        if args.save:
            return save_messages(args, d)
        return print_messages(args, d)
    except OSError as err:
        print(f"lb-read.py: cannot write: {err}", file=sys.stderr)
        return 1
    except ReadError as err:
        print(f"lb-read.py: {err}", file=sys.stderr)
        return 1
    except (ValueError, KeyError) as err:
        print(f"lb-read.py: unexpected reply from server ({err})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
