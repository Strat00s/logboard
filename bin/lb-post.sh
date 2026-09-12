#!/usr/bin/env bash
# lb-post.sh — post the output of any command to a logboard.
#
# Pure bash + curl: the message text comes from a pipe (stdin), -m or -f,
# everything else is plain arguments.
#
#   smartctl -H /dev/sda | lb-post.sh -c PC1 -t "drive health" -T smart
#   apt list --upgradable  | lb-post.sh -c PC1 -t "update check" -T apt
#   lb-post.sh -c NAS -t backup -T zfs -f /var/log/backup-last-run.log
#   lb-post.sh -c NAS -t scrub -T error -k s3cret -m "scrub stopped"
#   mycmd | lb-post.sh -c srv7 -t cron --ts 2026-09-01T08:00:00Z
#
# env: LB_URL (default http://127.0.0.1:8421), LB_TOKEN, LB_SOURCE.
# LB_TOKEN is preferred over -k — argv is visible in ps.
#
# exit: 0 posted · 1 server rejected / unreachable · 2 bad usage · 3 no curl

set -euo pipefail

URL="${LB_URL:-http://127.0.0.1:8421}"
TOKEN="${LB_TOKEN:-}"
CHANNEL="default"
THREAD="general"
SOURCE="${LB_SOURCE:-$(hostname 2>/dev/null || echo script)}"
MESSAGE=""
FILE=""
TS=""
TIMEOUT=15
RETRIES=2
QUIET=0
declare -a TAGS=()

usage() {
  local out=${1:-/dev/stdout}
  cat >"$out" <<'EOF'
lb-post.sh — post the output of any command to a logboard

usage: COMMAND | lb-post.sh -c CHANNEL -t THREAD [options]
       lb-post.sh (-m TEXT | -f PATH) [options]

options:
  -c, --channel NAME   target channel (default: "default", created if unknown)
  -t, --thread NAME    target thread   (default: "general", created if unknown)
  -T, --tag TAG        add a tag (repeatable; commas split, leading # stripped)
  -m, --message TEXT   message text (alternative to a pipe)
  -f, --file PATH      read the message text from a file ("-" for stdin)
      --ts WHEN        override the timestamp (ISO-8601, "YYYY-MM-DD HH:MM:SS",
                       or epoch seconds)
      --source NAME    label shown in the UI (default: hostname, env LB_SOURCE)
  -u, --url URL        server base URL (default: $LB_URL or http://127.0.0.1:8421)
  -k, --token TOKEN    server write token (only when the server sets LB_TOKEN;
                       prefer the env var — argv is visible in ps)
      --timeout SECS   per-request HTTP timeout (default: 15)
  -r, --retries N      curl retries on transient errors and 5x (default: 2)
  -q, --quiet          no output on success
  -h, --help           this help

new channels/threads are created by the server as *unassigned*; adopt them in
the web UI. Names match case-insensitively.
exit: 0 posted · 1 server rejected / unreachable · 2 bad usage · 3 no curl
EOF
  [ "${1:-/dev/stdout}" = /dev/stdout ] && exit 0 || exit 2
}

die()  { echo "lb-post.sh: $*" >&2; exit 2; }
fail() { echo "lb-post.sh: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -c|--channel) [ -n "${2:-}" ] || die "$1 needs a value"; CHANNEL=$2; shift 2 ;;
    -t|--thread)  [ -n "${2:-}" ] || die "$1 needs a value"; THREAD=$2;  shift 2 ;;
    -T|--tag)
      [ -n "${2:-}" ] || die "$1 needs a value"
      IFS=, read -ra parts <<<"$2"
      for p in "${parts[@]}"; do
        p=${p//[$'\r\n']/}
        p=${p#"${p%%[![:space:]]*}"}; p=${p%"${p##*[![:space:]]}"}  # trim
        p=${p#\#}
        [ -n "$p" ] && TAGS+=("$p")
      done
      shift 2 ;;
    -m|--message) [ -n "${2:-}" ] || die "$1 needs a value"; MESSAGE=$2; shift 2 ;;
    -f|--file)    [ -n "${2:-}" ] || die "$1 needs a value"; FILE=$2;    shift 2 ;;
    --ts)         [ -n "${2:-}" ] || die "$1 needs a value"; TS=$2;      shift 2 ;;
    --source)     [ -n "${2:-}" ] || die "$1 needs a value"; SOURCE=$2;  shift 2 ;;
    -u|--url)     [ -n "${2:-}" ] || die "$1 needs a value"; URL=$2;     shift 2 ;;
    -k|--token)   [ -n "${2:-}" ] || die "$1 needs a value"; TOKEN=$2;   shift 2 ;;
    --timeout)    [ -n "${2:-}" ] || die "$1 needs a value"; TIMEOUT=$2; shift 2 ;;
    -r|--retries) [ -n "${2:-}" ] || die "$1 needs a value"; RETRIES=$2; shift 2 ;;
    -q|--quiet)   QUIET=1; shift ;;
    -h|--help)    usage ;;
    --)         shift; [ $# -gt 0 ] && { usage /dev/stderr; die "unexpected argument: $1 (message text belongs in -m/-f/stdin)"; } ;;
    *)            usage /dev/stderr; die "unexpected argument: $1 (message text belongs in -m/-f/stdin)" ;;
  esac
done
URL=${URL%/}

# ---- message text: -m wins, then -f, then a piped stdin ---------------------
if [ -z "$MESSAGE" ]; then
  if [ -n "$FILE" ]; then
    [ "$FILE" = "-" ] || [ -r "$FILE" ] || die "cannot read $FILE"
    MESSAGE=$(cat -- "$FILE") || exit 2
  elif [ ! -t 0 ]; then
    MESSAGE=$(cat)
  fi
fi
[[ -z ${MESSAGE//[[:space:]]/} ]] && die "nothing to post (pipe something, or use -m/-f)"

command -v curl >/dev/null 2>&1 || { echo "lb-post.sh: curl is required" >&2; exit 3; }

# ---- JSON envelope -----------------------------------------------------------
# Strip control chars JSON forbids — but keep ESC (the board renders SGR
# colours) plus tab and newline; json_escape escapes ESC as \u001b.
json_text=$(printf '%s' "$MESSAGE" | tr -d '\000-\010\013\014\016-\032\034-\037')
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\r'/\\r}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\e'/\\u001b}
  printf '%s' "$s"
}

BODY=$(printf '{"channel":"%s","thread":"%s","text":"%s"' \
  "$(json_escape "$CHANNEL")" "$(json_escape "$THREAD")" "$(json_escape "$json_text")")
if ((${#TAGS[@]})); then
  tags_json=""
  for t in "${TAGS[@]}"; do
    tags_json+=${tags_json:+,}\"$(json_escape "$t")\"
  done
  BODY+=',"tags":['"$tags_json"']'
fi
[ -n "$TS" ]     && BODY+=',"ts":"'"$(json_escape "$TS")"'"'
[ -n "$SOURCE" ] && BODY+=',"source":"'"$(json_escape "$SOURCE")"'"'
BODY+='}'

# ---- POST ---------------------------------------------------------------------
cmd=(curl -sS --max-time "$TIMEOUT" --retry "$RETRIES" --retry-connrefused
     -H 'content-type: application/json'
     -o /dev/stdout -w '\n%{http_code} %{errormsg}'
     -X POST --data-binary "$BODY" "$URL/api/post")
[ -n "$TOKEN" ] && cmd+=(-H "x-post-token: $TOKEN")

raw=$("${cmd[@]}") || fail "could not reach $URL/api/post"
last=${raw##*$'\n'}   # write-out tail: "<http_code> <errormsg>"
code=${last%% *}
reason=${last#"$code"}
reason=${reason# }
body=${raw%"$last"}
body=${body%$'\n'}
if [[ $code != 2* ]]; then
  detail=""
  [[ $body =~ \"error\":\"((\\.|[^\"\\])*)\" ]] && detail=${BASH_REMATCH[1]}
  fail "HTTP $code${detail:+: $detail}${reason:+ ($reason)}"
fi

# ---- ack line (same format as bin/lb-post) ------------------------------------
if [ "$QUIET" = 1 ]; then
  exit 0
fi
re_id='"message":\{"id":([0-9]+)'
re_chars='"chars":([0-9]+)'
re_chan='"channel":\{"id":[0-9]+,"name":"((\\.|[^"\\])*)"'
re_thr='"thread":\{"id":[0-9]+,"channel_id":[0-9]+,"name":"((\\.|[^"\\])*)"'
re_chan_obj='"channel":\{([^{}]*)\}'
re_thr_obj='"thread":\{([^{}]*)\}'
if [[ $body =~ $re_id ]]; then id=${BASH_REMATCH[1]};
   elif [[ $body =~ \"id\":([0-9]+) ]]; then id=${BASH_REMATCH[1]}; else id='?'; fi
[[ $body =~ $re_chars ]] && chars=${BASH_REMATCH[1]} || chars='?'
[[ $body =~ $re_chan ]]  && cname=${BASH_REMATCH[1]}  || cname=''
[[ $body =~ $re_thr ]]   && tname=${BASH_REMATCH[1]}  || tname=''
if [[ -z $cname || -z $tname ]]; then
  printf '%s\n' "$body"   # server replied ok in a shape we don't know — show it
  exit 0
fi

note=""
[[ $body =~ $re_chan_obj ]] && chan_obj=${BASH_REMATCH[1]} || chan_obj=""
[[ $body =~ $re_thr_obj  ]] && thr_obj=${BASH_REMATCH[1]}  || thr_obj=""
cnew=0; tnew=0
[[ $chan_obj == *'"created":true'* ]] && cnew=1
[[ $thr_obj  == *'"created":true'* ]] && tnew=1
if ((cnew || tnew)); then
  what=$(((cnew && tnew) ? 0 : 1))
  label=$([ "$what" = 0 ] && echo "channel+thread" || echo "target")
  chunk=$([ "$cnew" = 1 ] && echo "$chan_obj" || echo "$thr_obj")
  expiry=""
  [[ $chunk =~ \"expires_at\":\"([^\"]*)\" ]] && expiry=${BASH_REMATCH[1]}
  note="  (NEW $label — unassigned, expires $expiry)"
fi
printf 'posted #%s -> %s/%s  %s chars%s\n' "$id" "$cname" "$tname" "$chars" "$note"
