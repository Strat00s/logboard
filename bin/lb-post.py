#!/usr/bin/env python3
"""lb-post.py — post the output of any command to a logboard.

The message text comes from a pipe (stdin), from --message, or from --file;
everything else is plain arguments:

  smartctl -H /dev/sda            | lb-post.py -c PC1 -t "drive health" -T smart
  apt list --upgradable            | lb-post.py -c PC1 -t "update check" -T apt
  lb-post.py -c NAS -t backup -T zfs -f /var/log/backup-last-run.log
  lb-post.py -c NAS -t scrub -T error -k s3cret -m "scrub stopped with errors"
  mycmd | lb-post.py -c srv7 -t cron --ts 2026-09-01T08:00:00Z

env: LB_URL (default http://127.0.0.1:8421), LB_TOKEN (only if the server
sets LB_TOKEN; the env var is preferred over -k, which is visible in ps).

Exit codes: 0 posted · 1 server rejected / unreachable · 2 bad usage.
Uses only the Python standard library.
"""

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8421"


def parse_args(argv):
    host = socket.gethostname().split(".")[0] or "script"
    ap = argparse.ArgumentParser(
        prog="lb-post.py",
        description=__doc__.splitlines()[0],
        epilog=(
            "new channels/threads are created by the server as *unassigned*;\n"
            "adopt them in the web UI. Names match case-insensitively."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("-c", "--channel", default="default",
                    help='target channel (default: "default")')
    ap.add_argument("-t", "--thread", default="general",
                    help='target thread (default: "general")')
    ap.add_argument("-T", "--tag", action="append", default=[],
                    metavar="TAG", help="add a tag (repeatable, commas split too)")
    ap.add_argument("-m", "--message", metavar="TEXT",
                    help="message text (alternative to a pipe)")
    ap.add_argument("-f", "--file", metavar="PATH",
                    help='read the message text from a file ("-" for stdin)')
    ap.add_argument("--ts", metavar="WHEN",
                    help="override the message timestamp (ISO-8601, "
                         '"YYYY-MM-DD HH:MM:SS", or epoch seconds)')
    ap.add_argument("--source", default=os.environ.get("LB_SOURCE") or host,
                    metavar="NAME", help="label shown in the UI (default: hostname)")
    ap.add_argument("-u", "--url", default=os.environ.get("LB_URL") or DEFAULT_URL,
                    metavar="URL", help=f"server base URL (default: $LB_URL or {DEFAULT_URL})")
    ap.add_argument("-k", "--token", default=os.environ.get("LB_TOKEN") or None,
                    metavar="TOKEN",
                    help="server write token — prefer LB_TOKEN, argv is visible in ps")
    ap.add_argument("--timeout", type=float, default=15.0, metavar="SECS",
                    help="per-request HTTP timeout (default: 15)")
    ap.add_argument("-r", "--retries", type=int, default=2, metavar="N",
                    help="retries on network errors and 5x (default: 2)")
    ap.add_argument("-q", "--quiet", action="store_true",
                    help="no output on success")
    args = ap.parse_args(argv)
    tags = [t.strip().lstrip("#") for spec in args.tag for t in spec.split(",")]
    args.tags = [t for t in tags if t]
    args.url = args.url.rstrip("/")
    return args


def read_text(args):
    """Message text: -m wins, then -f, then a piped stdin."""
    if args.message is not None:
        return args.message
    path = args.file
    if path is None and not sys.stdin.isatty():
        path = "-"
    if path is None:
        return ""
    if path == "-":
        data = sys.stdin.buffer.read()
    else:
        with open(path, "rb") as fh:
            data = fh.read()
    return data.decode("utf-8", errors="replace")


def post(args, payload):
    """POST the payload; returns (status, parsed_json) or raises PostError."""
    req = urllib.request.Request(
        args.url + "/api/post",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    if args.token:
        req.add_header("x-post-token", args.token)
    last = "no response"
    for attempt in range(args.retries + 1):
        if attempt:
            time.sleep(min(2 ** attempt, 10) * 0.5)
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(body).get("error") or body.strip()
            except (ValueError, AttributeError):
                detail = body.strip() or err.reason
            if err.code < 500:
                raise PostError(f"HTTP {err.code}: {detail}") from None
            last = f"HTTP {err.code}: {detail}"
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as err:
            last = str(getattr(err, "reason", err)) or err.__class__.__name__
    raise PostError(f"could not reach {args.url}/api/post: {last}")


class PostError(Exception):
    pass


def main(argv=None):
    args = parse_args(argv)
    if args.retries < 0:
        print("lb-post.py: --retries must be >= 0", file=sys.stderr)
        return 2
    try:
        text = read_text(args)
    except OSError as err:
        print(f"lb-post.py: {err.strerror or err}: {err.filename}", file=sys.stderr)
        return 2
    if not text.strip():
        print("lb-post.py: nothing to post (pipe something, or use -m/-f)", file=sys.stderr)
        return 2

    payload = {"channel": args.channel, "thread": args.thread, "text": text}
    if args.tags:
        payload["tags"] = args.tags
    if args.ts:
        payload["ts"] = args.ts
    if args.source:
        payload["source"] = args.source

    try:
        _, resp = post(args, payload)
    except PostError as err:
        print(f"lb-post.py: {err}", file=sys.stderr)
        return 1
    except (ValueError, KeyError) as err:
        print(f"lb-post.py: unexpected reply from server ({err})", file=sys.stderr)
        return 1

    if not resp.get("ok"):
        print(f'lb-post.py: {resp.get("error", "unknown error")}', file=sys.stderr)
        return 1
    if args.quiet:
        return 0
    msg, chan, thr = resp["message"], resp["channel"], resp["thread"]
    note = ""
    if chan.get("created") or thr.get("created"):
        what = "channel+thread" if chan.get("created") and thr.get("created") else "target"
        expiry = (chan if chan.get("created") else thr).get("expires_at")
        note = f"  (NEW {what} — unassigned, expires {expiry})"
    print(f'posted #{msg["id"]} -> {chan["name"]}/{thr["name"]}'
          f'  {msg["chars"]} chars{note}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
