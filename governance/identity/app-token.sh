#!/usr/bin/env bash
# Print a short-lived installation token for an agent identity App.
#
#   GH_TOKEN="$(governance/identity/app-token.sh mm-reviewer)" gh ...   # one command
#
# In an agent shell use governance/identity/agent-env.sh instead: its gh and
# its git credential helper call this for every command, so no shell variable
# ever holds a token.
#
# Reads ~/.config/mm-agent/<name>/{app.json,private-key.pem}, written by
# `python3 -I -S governance/identity/create-app.py <name>`.
#
# The cache: a token is reused for at most 5 minutes after it was minted,
# although GitHub lets it live an hour. So once an installation is revoked or
# suspended, its token is served for at most 5 more minutes; then the mint
# fails with GitHub's reason. Checking the cached token on every use would
# close even that gap, but it would add a round trip to every gh and git call
# (GET /rate_limit took 0.49 s from the owner's machine), and GitHub does not
# document that a cheap endpoint reflects a suspension. The cap costs two
# requests per identity every 5 minutes.
#
# ORG selects the organisation (default marvinamiranda); the App must be
# installed on it. Prints only an installation token (ghs_...); anything else, from the cache
# or from GitHub, is a failure. Never echoes the private key, or a token on
# failure: a failed call prints its HTTP status and GitHub's message, and a
# 401 discards the cache.
set -euo pipefail

NAME=${1:?usage: app-token.sh <mm-agent|mm-reviewer>}
ORG=${ORG:-marvinamiranda}
[[ "$ORG" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || { echo "ORG=$ORG is not a GitHub organisation name" >&2; exit 1; }
DIR="$HOME/.config/mm-agent/$NAME"
KEY="$DIR/private-key.pem"
# One cache per org: an installation token is valid for one org's repositories
# only. marvinamiranda keeps the original file name, so older copies of this
# script keep reading it; any other org gets token.cache.<org> (lower-cased).
if [[ "$ORG" == marvinamiranda ]]; then CACHE="$DIR/token.cache"; else CACHE="$DIR/token.cache.$(printf '%s' "$ORG" | tr 'A-Z' 'a-z')"; fi
REUSE_SECONDS=300
[[ -r "$KEY" && -r "$DIR/app.json" ]] || { echo "missing $DIR — the owner creates it with python3 -I -S governance/identity/create-app.py $NAME" >&2; exit 1; }

is_installation_token() { [[ "$1" == ghs_?* ]]; }

now=$(date +%s)
# Line 1, "<expiry> <token>", is all that older copies of this script read, so
# they keep working beside this one. Line 2 is when the token was minted; a
# cache without it (written by an older copy) is not reused.
if [[ -r "$CACHE" ]]; then
  exp="" tok="" minted=""
  { read -r exp tok; read -r minted; } <"$CACHE" || true
  if [[ "$exp" =~ ^[0-9]+$ && "$minted" =~ ^[0-9]+$ ]] && is_installation_token "$tok" \
      && (( minted <= now && now - minted < REUSE_SECONDS && exp - 300 > now )); then
    printf '%s\n' "$tok"
    exit 0
  fi
fi

APP_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$DIR/app.json")
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$APP_ID" | b64url)
sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$KEY" -binary | b64url)
jwt="$header.$payload.$sig"

BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/app-token.XXXXXX")"
tmp=""
trap 'rm -f "$BODY_FILE" ${tmp:+"$tmp"}' EXIT

# api <what> <curl args...>: prints the response body; on a non-2xx status
# prints the status and GitHub's message to stderr and fails.
api() {
  local what="$1"; shift
  local status
  status=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
    -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$@") || { echo "$what: request failed (network)" >&2; return 1; }
  if [[ "$status" != 2* ]]; then
    local message
    message=$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("message",""))
except Exception: print(open(sys.argv[1]).read()[:300])' "$BODY_FILE")
    echo "$what: HTTP $status — $message" >&2
    if [[ "$status" == 401 ]]; then rm -f "$CACHE"; echo "(token cache discarded)" >&2; fi
    return 1
  fi
  cat "$BODY_FILE"
}

inst_json=$(api "App $NAME installation on $ORG" "https://api.github.com/orgs/$ORG/installation") \
  || { echo "Is $NAME installed on $ORG, and is its key current?" >&2; exit 1; }
inst=$(printf '%s' "$inst_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
resp=$(api "Installation token for $NAME" -X POST "https://api.github.com/app/installations/$inst/access_tokens") || exit 1
tok=$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
exp=$(printf '%s' "$resp" | python3 -c 'import json,sys,datetime;print(int(datetime.datetime.fromisoformat(json.load(sys.stdin)["expires_at"].replace("Z","+00:00")).timestamp()))')
is_installation_token "$tok" || { echo "Installation token for $NAME: GitHub returned no installation token (ghs_...)" >&2; exit 1; }

# Written whole, then renamed over the cache, so no reader sees half a line.
umask 077
tmp="$(mktemp "$DIR/.token.new.XXXXXX")"
printf '%s %s\n%s\n' "$exp" "$tok" "$now" >"$tmp"
mv -f "$tmp" "$CACHE"
tmp=""
printf '%s\n' "$tok"
