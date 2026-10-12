#!/usr/bin/env bash
# Install, or refresh, an agent identity, and print its environment for `eval`
# (DELIVERY Appendix A). From a checkout of a merged commit, by the script's
# absolute path, and never without `|| echo false`: a bare `eval "$(...)"` of a
# script that is not there evaluates nothing, succeeds, and whatever follows
# runs as the owner:
#
#   eval "$(<checkout>/governance/identity/agent-env.sh mm-agent || echo false)" && gh auth status
#
# THE PER-COMMAND FORM, which must open every tool command in Claude Code and
# Codex, sources the env file that eval installed, joined with && (never ;):
#
#   . ~/.config/mm-agent/mm-agent/env && gh pr create ...
#
# A missing env file fails the `.`, and so stops the command; an env file whose
# shim is gone fails the same way. Only an eval from a commit on
# marvinamiranda/.github test writes the env file, so it only ever runs merged
# code; an eval from anywhere else sets up its own shell and leaves it alone.
#
# Both CLIs rebuild each tool command's shell from a snapshot they took when
# the session began, and a snapshot taken from the owner's environment carries
# it: Claude Code's re-applies the PATH it captured, which puts the real gh
# first; Codex's re-exports every variable it captured, which on the owner's
# machine includes their gh login token as GH_PACKAGES_TOKEN (from ~/.zshrc).
# That is the residual: a tool command that does not open with the env file
# runs as its snapshot has it; an alias named gh in the snapshot is expanded
# when the command line is parsed, before the env file can remove it (`command
# gh` sidesteps one); and the snapshot files keep whatever was exported when
# they were taken.
#
# Everything it prints is exported, so whatever a command starts inherits it:
# scripts, `bash -c`, and zsh, login or interactive. It sets:
#   PATH            the identity's gh first: ~/.config/mm-agent/<name>/shim/
#                   <commit>/bin/gh, a launcher for COPIES of gh-shim.sh and
#                   app-token.sh taken from a commit (below).
#                   Every gh call gets a token minted for it, and fails rather
#                   than fall back when none can be minted. The shim refuses
#                   `gh auth` (bar a plain `gh auth status`) and any flag ahead
#                   of the command, so no command hands out a raw token.
#   ZDOTDIR         zsh startup files of the identity's that source the owner's
#                   own (~/.zshenv, ~/.zprofile, ~/.zshrc, ~/.zlogin), then put
#                   the shim first again and these variables back. The owner's
#                   ~/.zprofile runs `brew shellenv`, which would otherwise put
#                   the real gh first in every login zsh. The owner's files are
#                   read, never edited.
#   GH_TOKEN        a sentinel, not a token; the shim replaces it on every call.
#                   A real gh reached some other way, such as a PATH that puts
#                   it first, answers `gh auth token` with the sentinel instead
#                   of the keyring login, and GitHub refuses the sentinel.
#   GITHUB_TOKEN    unset: nothing inherited from the owner's shell survives.
#   GH_PACKAGES_TOKEN  read from ~/.config/mm-agent/packages-token, which the
#                   owner creates (a classic token, read:packages only, mode
#                   0600), because GitHub Packages takes no App token. Unset,
#                   with a one-line hint, when that file is missing, open to
#                   anyone else, or holds anything but one classic token.
#   GH_CONFIG_DIR   an EMPTY directory of this identity's, so the real gh finds
#                   no stored login.
#   MM_REAL_GH_BIN  the absolute path of the real gh found before the shim was
#                   installed, for helpers that must call it directly. Unset
#                   when this environment is locked.
#   git identity    author and committer are the App's bot user.
#   git credentials for github.com: the helper list is reset, then one helper
#                   mints a token for each operation, and tells git to stop
#                   (quit=true) instead of trying another credential or
#                   prompting when it cannot.
#
# The copies are what every gh and git call runs, so they come from a commit,
# never a working tree: it refuses a checkout whose three identity scripts
# differ from its HEAD commit (a change hidden from `git status` included), and
# warns when that commit is not on marvinamiranda/.github test. Each commit gets
# its own directory. Which one a shell runs depends on the form:
#   the eval    installs what the checkout's HEAD is at that moment and switches
#               that shell to it; the shell keeps it when the checkout changes
#               or goes away, until it evaluates again.
#   the env file  runs the commit it names: the last one an eval from a commit
#               on test installed on this machine. The checkout can change or
#               go away without touching it.
#
# If anything fails once it is running, it prints an environment with NO
# GitHub identity rather than nothing, since `eval ""` would leave the shell on
# the owner's login: the sentinel, a gh that refuses everything (kept first in
# zsh the same way), git told to quit, no commit identity, and a status that
# makes the eval fail. A script that cannot run at all prints nothing, which
# is what `|| echo false` is for. A failed run leaves the env file as it was.
#
# This is a strong default, not a sandbox. Agents run on the owner's machine,
# under the owner's user, and the owner's keyring login is one absolute path
# away (`/opt/homebrew/bin/gh auth token --user <owner>`). The rulesets are the
# backstop (DELIVERY §9).
set -euo pipefail

ROOT="$HOME/.config/mm-agent"
LOCK="$ROOT/locked"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SENTINEL="mm-agent-sentinel-not-a-token"
PACKAGES_TOKEN="$ROOT/packages-token"
q() { printf '%q' "$1"; }

# Replace $1 (mode $2) with stdin, by rename, so a shell or script that has the
# old file open goes on reading the old one.
install_file() {
  local tmp
  tmp="$(mktemp "$(dirname "$1")/.new.XXXXXX")" || return 1
  if cat >"$tmp" && chmod "$2" "$tmp" && mv -f "$tmp" "$1"; then return 0; fi
  rm -f "$tmp"
  return 1
}

# The variables every environment here sets alike, one command per line, valid
# in bash and zsh: $1 GH_CONFIG_DIR, $2 ZDOTDIR, $3 git author, $4 git email,
# $5 the github.com credential helper, $6 the real gh path (empty when locked).
body_lines() {
  printf 'export GH_TOKEN=%s\n' "$(q "$SENTINEL")"
  printf 'unset GITHUB_TOKEN\n'
  printf 'export GH_CONFIG_DIR=%s\n' "$(q "$1")"
  printf 'export ZDOTDIR=%s\n' "$(q "$2")"
  printf 'export GIT_AUTHOR_NAME=%s GIT_COMMITTER_NAME=%s\n' "$(q "$3")" "$(q "$3")"
  printf 'export GIT_AUTHOR_EMAIL=%s GIT_COMMITTER_EMAIL=%s\n' "$(q "$4")" "$(q "$4")"
  printf 'export GIT_CONFIG_COUNT=3\n'
  printf 'export GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0=\n'
  printf 'export GIT_CONFIG_KEY_1=credential.https://github.com.helper GIT_CONFIG_VALUE_1=%s\n' "$(q "$5")"
  # git sends the repository path to the helper only with useHttpPath; the
  # helper picks the org from it (ThruuAi/..., else marvinamiranda).
  printf 'export GIT_CONFIG_KEY_2=credential.https://github.com.useHttpPath GIT_CONFIG_VALUE_2=true\n'
  if [[ -n "${6:-}" ]]; then
    printf 'export MM_REAL_GH_BIN=%s\n' "$(q "$6")"
  else
    printf 'unset MM_REAL_GH_BIN\n'
  fi
}

# Lines that record the owner's ZDOTDIR, for the zsh startup files to source
# (empty means their HOME). A ZDOTDIR of ours is a previous eval's, which
# recorded it already. Run where the environment is set up, so every shell gets
# its own; valid in sh, bash and zsh.
owner_zdotdir_lines() {
  cat <<EOF
case "\${ZDOTDIR:-}" in $(q "$ROOT") | $(q "$ROOT")/*) ;; *) MM_AGENT_OWNER_ZDOTDIR="\${ZDOTDIR:-}" ;; esac
case "\${MM_AGENT_OWNER_ZDOTDIR:-}" in $(q "$ROOT") | $(q "$ROOT")/*) MM_AGENT_OWNER_ZDOTDIR= ;; esac
export MM_AGENT_OWNER_ZDOTDIR
EOF
}

# Lines that put $1 first on PATH and drop every other directory of ours (a
# previous eval's), computed from PATH as it is where they run. sh, bash, zsh.
path_lines() {
  cat <<EOF
_mm_rest="\$PATH:"
_mm_path=
while [ -n "\$_mm_rest" ]; do
  _mm_d="\${_mm_rest%%:*}"
  _mm_rest="\${_mm_rest#*:}"
  case "\$_mm_d" in $(q "$ROOT") | $(q "$ROOT")/*) ;; *) _mm_path="\${_mm_path:+\$_mm_path:}\$_mm_d" ;; esac
done
PATH=$(q "$1")"\${_mm_path:+:\$_mm_path}"
export PATH
unset _mm_rest _mm_path _mm_d
hash -r 2>/dev/null || true
EOF
}

# reassert.zsh: run after each of the owner's startup files. $1 the directory
# whose gh must come first, $2 the body_lines.
reassert_zsh() {
  cat <<EOF
# Written by agent-env.sh, which rewrites it when what it holds changes. The
# startup files beside it source this after each of the owner's: whatever
# those did, this gh comes first on PATH, no alias or function shadows it, and
# the variables are the eval's again. GH_PACKAGES_TOKEN goes back to the value
# zsh inherited.
() {
  emulate -L zsh
  local d
  local -a keep
  for d in \$path; do
    [[ \$d == $(q "$ROOT") || \$d == $(q "$ROOT")/* ]] || keep+=("\$d")
  done
  path=($(q "$1") \$keep)
  hash -r
  unalias gh 2>/dev/null || true
  unfunction gh 2>/dev/null || true
  if [[ -n \${_mm_agent_pkg_set-} ]]; then
    export GH_PACKAGES_TOKEN=\${_mm_agent_pkg-}
  else
    unset GH_PACKAGES_TOKEN
  fi
$2
}
EOF
}

# One zsh startup file ($1, e.g. .zprofile) for ZDOTDIR $2: it runs the owner's
# file of that name, with ZDOTDIR set to the owner's directory while it does,
# then reassert.zsh. The owner's directory is MM_AGENT_OWNER_ZDOTDIR, or HOME;
# never one of ours, which would recurse.
startup_zsh() {
  local name="$1" dir="$2"
  cat <<EOF
# Written by agent-env.sh, which rewrites it when what it holds changes. zsh
# reads this instead of the owner's $name because agent-env.sh exported
# ZDOTDIR: it runs theirs, then puts the agent environment back.
EOF
  if [[ "$name" == .zshenv ]]; then
    cat <<'EOF'
typeset -g _mm_agent_owner="${MM_AGENT_OWNER_ZDOTDIR:-$HOME}"
typeset -g _mm_agent_pkg_set="${GH_PACKAGES_TOKEN+1}" _mm_agent_pkg="${GH_PACKAGES_TOKEN-}"
EOF
  fi
  if [[ "$name" == .zshrc ]]; then
    # macOS /etc/zshrc, read just before this, puts the history in ZDOTDIR.
    cat <<EOF
if [[ "\${HISTFILE-}" == $(q "$dir")/.zsh_history ]]; then HISTFILE="\${_mm_agent_owner:-\$HOME}/.zsh_history"; fi
EOF
  fi
  cat <<EOF
if [[ "\${_mm_agent_owner:-\$HOME}" != $(q "$ROOT") && "\${_mm_agent_owner:-\$HOME}" != $(q "$ROOT")/* \\
    && -r "\${_mm_agent_owner:-\$HOME}/$name" ]]; then
  ZDOTDIR="\${_mm_agent_owner:-\$HOME}"
  source "\$ZDOTDIR/$name"
EOF
  if [[ "$name" == .zshenv ]]; then
    cat <<'EOF'
  _mm_agent_owner="${ZDOTDIR:-$HOME}"  # their .zshenv may have moved their ZDOTDIR
EOF
  fi
  printf '  ZDOTDIR=%s\nfi\n' "$(q "$dir")"
  if [[ "$name" != .zlogout ]]; then printf 'source %s\n' "$(q "$dir/reassert.zsh")"; fi
}

# The ZDOTDIR directory $1, whose startup files keep the gh in $2 first and set
# the body_lines $3.
write_zdotdir() {
  local f
  { mkdir -p "$1" && chmod 700 "$1"; } || return 1
  reassert_zsh "$2" "$3" | install_file "$1/reassert.zsh" 600 || return 1
  for f in .zshenv .zprofile .zshrc .zlogin .zlogout; do
    startup_zsh "$f" "$1" | install_file "$1/$f" 600 || return 1
  done
}

PRINTED=0
STAGE="" # the private directory the scripts are read into; removed on exit
locked() {
  PRINTED=1
  local lock_body
  mkdir -p "$LOCK/bin" "$LOCK/gh" 2>/dev/null || true
  chmod 700 "$ROOT" "$LOCK" "$LOCK/gh" 2>/dev/null || true
  { printf '#!/bin/sh\n'
    printf 'echo "gh: refused: this shell has no GitHub identity, because governance/identity/agent-env.sh failed. Fix what it said, then eval it again." >&2\n'
    printf 'exit 1\n'; } | install_file "$LOCK/bin/gh" 755 2>/dev/null || true
  lock_body="$(body_lines "$LOCK/gh" "$LOCK/zdotdir" "" "" '!f(){ echo quit=true; }; f' "")"
  write_zdotdir "$LOCK/zdotdir" "$LOCK/bin" "$lock_body" 2>/dev/null || true
  # `function gh`, not `gh()`: zsh parses the whole eval before running any
  # of it, and with an alias named gh, `gh() {` is a parse error that throws
  # away every line here.
  cat <<EOF
unset GH_TOKEN GITHUB_TOKEN GH_PACKAGES_TOKEN
unset -f gh 2>/dev/null || true; unalias gh 2>/dev/null || true
function gh { echo "gh: refused: this shell has no GitHub identity, because agent-env.sh failed." >&2; return 1; }
$(owner_zdotdir_lines)
$lock_body
$(path_lines "$LOCK/bin")
echo $(q "agent-env.sh: $1") >&2
echo 'agent-env.sh: this shell now has NO GitHub identity: gh, git pushes and commits refuse until agent-env.sh succeeds.' >&2
false
EOF
  exit 1
}
# Any failure not caught below still prints the environment with no identity.
on_exit() {
  local rc=$?
  [[ -z "$STAGE" ]] || rm -rf "$STAGE"
  if [[ $rc -ne 0 && $PRINTED -eq 0 ]]; then locked "stopped (exit $rc) before it finished"; fi
}
trap on_exit EXIT

# PATH without any directory of ours (a previous eval's shim), so evals do not
# stack, and the gh found here is the real one, never a shim.
clean_path=""
real_gh=""
root_canon="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$ROOT" 2>/dev/null)" \
  || locked "python3 is required to verify the real gh path"
[[ "$root_canon" == /* ]] || locked "cannot resolve the mm-agent directory for real gh verification"
IFS=: read -r -a path_dirs <<<"$PATH"
for d in ${path_dirs[@]+"${path_dirs[@]}"}; do
  case "$d" in "$ROOT" | "$ROOT"/*) continue ;; esac
  clean_path="${clean_path:+$clean_path:}$d"
  if [[ -z "$real_gh" && "$d" == /* && -f "$d/gh" && -x "$d/gh" ]]; then
    candidate_canon="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$d/gh" 2>/dev/null)" || continue
    [[ "$candidate_canon" == /* && -f "$candidate_canon" && -x "$candidate_canon" ]] || continue
    case "$candidate_canon" in "$root_canon" | "$root_canon"/*) continue ;; esac
    real_gh="$candidate_canon"
  fi
done

[[ $# -eq 1 ]] || locked "usage: agent-env.sh <mm-agent|mm-reviewer>"
NAME="$1"
case "$NAME" in mm-agent | mm-reviewer) ;; *) locked "unknown identity: $NAME (mm-agent or mm-reviewer)" ;; esac
DIR="$ROOT/$NAME"
APP_JSON="$DIR/app.json"
GH_DIR="$DIR/gh"
[[ -r "$APP_JSON" ]] || locked "missing $APP_JSON; the owner creates it with python3 -I -S governance/identity/create-app.py $NAME"
[[ -x "$HERE/gh-shim.sh" && -x "$HERE/app-token.sh" && -r "$HERE/provenance.sh" ]] || locked "gh-shim.sh, app-token.sh or provenance.sh is missing beside $0"
[[ -n "$real_gh" ]] || locked "no gh on PATH"
command -v git >/dev/null || locked "git is required"

# The commit the copies come from, and the copies. No git process runs in the
# checkout: anything that can write under its .git could make git run code
# there (core.fsmonitor, a clean filter) or read other content under a real
# object id (provenance.sh says how). HEAD's id is read from its files; the
# three scripts are read once, into a private directory, and those bytes are
# what is hashed, compared with the commit, installed, and checked against
# marvinamiranda/.github test below. So a change hidden from `git status`
# (update-index --assume-unchanged) is refused too.
# shellcheck source=provenance.sh disable=SC1091
. "$HERE/provenance.sh"
top="$(mm_provenance_top "$HERE")" \
  || locked "$HERE is not in a git checkout with a commit, so what it would install cannot be tied to one. Eval from a clone of marvinamiranda/.github."
# provenance.sh's commands (git, and its helpers) run from / with the
# caller's PATH less any empty, relative or in-checkout entry.
# shellcheck disable=SC2034 # read by provenance.sh's mm_run and mm_scratch_git
MM_PROVENANCE_PATH="$(mm_provenance_safe_path "$top")"
commit="$(mm_provenance_head "$top")" \
  || locked "cannot read the commit of the checkout at $top from its HEAD file (a detached HEAD, or a branch in a loose or packed ref, is needed)"
prefix="$(cd "$HERE" && pwd -P)" || locked "cannot resolve $HERE"
prefix="${prefix#"$top"}"
prefix="${prefix#/}"
[[ -z "$prefix" ]] || prefix="$prefix/"
STAGE="$(mktemp -d "$DIR/.stage.XXXXXX")" || locked "cannot make a private directory under $DIR"
SCRIPT_FILES=(agent-env.sh gh-shim.sh app-token.sh)
for f in "${SCRIPT_FILES[@]}"; do
  mm_run cat -- "$HERE/$f" >"$STAGE/$f" 2>/dev/null || locked "cannot read the scripts in $HERE"
done
# Offline, the commit is the checkout's own: its objects, read through
# alternates by a repository of this script's, which reads none of the
# checkout's config, refs or hooks. Whether that commit is merged is decided
# below, from test as fetched.
{ IFS= read -r _gitdir && IFS= read -r common; } <<<"$(mm_provenance_gitdirs "$top")" || locked "cannot find the objects of the checkout at $top"
local_repo="$STAGE/local.git"
if ! mm_scratch_git "$local_repo" init --quiet --bare --template= >/dev/null 2>&1 \
    || ! printf '%s\n' "$common/objects" >"$local_repo/objects/info/alternates"; then
  locked "cannot make a private repository under $STAGE"
fi
have=""
for f in "${SCRIPT_FILES[@]}"; do
  blob="$(mm_scratch_git "$local_repo" hash-object --no-filters --stdin <"$STAGE/$f")" || locked "cannot hash the scripts in $HERE"
  have="${have:+$have$'\n'}$blob"
done
want="$(mm_scratch_git "$local_repo" rev-parse "$commit:${prefix}agent-env.sh" "$commit:${prefix}gh-shim.sh" "$commit:${prefix}app-token.sh" 2>/dev/null)" \
  || locked "agent-env.sh, gh-shim.sh and app-token.sh are not all in commit ${commit:0:12}. Eval from a clean checkout of a merged commit."
[[ "$have" == "$want" ]] \
  || locked "a script in $HERE differs from commit ${commit:0:12} (uncommitted changes, or ones hidden from git status). Commit or discard them, or eval from a clean checkout of a merged commit."

SHIM="$DIR/shim/$commit"
BIN="$SHIM/bin"
LIBEXEC="$SHIM/libexec"
ZD="$SHIM/zdotdir"
TOKEN_CMD="$LIBEXEC/app-token.sh"
if ! { mkdir -p "$GH_DIR" "$BIN" "$LIBEXEC" && chmod 700 "$ROOT" "$DIR" "$DIR/shim" "$SHIM" "$GH_DIR" "$BIN" "$LIBEXEC"; }; then
  locked "cannot create $GH_DIR and $SHIM"
fi
[[ ! -e "$GH_DIR/hosts.yml" ]] || locked "$GH_DIR/hosts.yml exists: this directory must hold no login. Remove it."

# The copies: the bytes read and checked above, never the checkout's objects.
# Rewritten whenever they differ from what is there, each whole before it is
# renamed into place.
for f in gh-shim.sh app-token.sh; do
  if [[ ! -x "$LIBEXEC/$f" ]] || ! cmp -s "$STAGE/$f" "$LIBEXEC/$f"; then
    install_file "$LIBEXEC/$f" 700 <"$STAGE/$f" || locked "cannot write $LIBEXEC/$f"
  fi
done

slug="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["slug"])' "$APP_JSON")" \
  || locked "no slug in $APP_JSON"
bot="${slug}[bot]"
# The bot user's id never changes: it is looked up once, then read back, so an
# eval needs no network.
bot_id=""
if [[ -r "$DIR/bot-id" ]]; then read -r bot_id <"$DIR/bot-id" || true; fi
if [[ ! "$bot_id" =~ ^[0-9]+$ ]]; then
  token="$("$TOKEN_CMD" "$NAME")" \
    || locked "no $NAME token could be minted to look up its bot user (app-token.sh said why, above)"
  bot_id="$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -fsS -K - -H "Accept: application/vnd.github+json" \
    "https://api.github.com/users/${slug}%5Bbot%5D" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')" \
    || locked "could not look up the bot user $bot"
  unset token
  [[ "$bot_id" =~ ^[0-9]+$ ]] || locked "unexpected id for $bot: $bot_id"
  printf '%s\n' "$bot_id" >"$DIR/bot-id"
fi
email="${bot_id}+${bot}@users.noreply.github.com"

# For `get`: a fresh token, or quit=true when there is none, so git neither
# prompts nor tries another credential.
# shellcheck disable=SC2016  # git's shell expands these when it runs the helper
helper='!f(){ test "$1" = get || exit 0; p=$(sed -n "s/^path=//p" | head -n 1); case "$p" in [Tt][Hh][Rr][Uu][Uu][Aa][Ii]/*) o=ThruuAi;; *) o=marvinamiranda;; esac; t=$(MM_GH_ORG=$o '"$(q "$TOKEN_CMD") $(q "$NAME")"') || t=; case "$t" in ghs_?*) printf "username=x-access-token\npassword=%s\n" "$t";; *) echo quit=true;; esac; }; f'

# GH_PACKAGES_TOKEN. GitHub Packages accepts only a classic personal access
# token, which no App can mint, so the owner makes one with read:packages alone
# and keeps it in a file only they can read. The printed environment reads the
# file when it is evaluated: the token itself is never printed.
packages_line=""
if [[ ! -e "$PACKAGES_TOKEN" && ! -L "$PACKAGES_TOKEN" ]]; then
  packages_hint="there is no $PACKAGES_TOKEN"
else
  packages_hint="$(python3 - "$PACKAGES_TOKEN" <<'PY'
import os, re, stat, sys
path = sys.argv[1]
def no(why):
    print(path + " " + why)
    sys.exit(0)
try:
    st = os.lstat(path)
except OSError as e:
    no("cannot be read (%s)" % e.strerror)
if stat.S_ISLNK(st.st_mode):
    no("is a symbolic link; it must be a regular file")
if not stat.S_ISREG(st.st_mode):
    no("is not a regular file")
if st.st_uid != os.getuid():
    no("is not yours")
mode = stat.S_IMODE(st.st_mode)
if mode & 0o077:
    no("is open to others (mode %04o): chmod 600 it" % mode)
try:
    with open(path) as f:
        text = f.read()
except OSError as e:
    no("cannot be read (%s)" % e.strerror)
if not re.fullmatch(r"ghp_[A-Za-z0-9]+\n?", text):
    no("does not hold exactly one classic personal access token (ghp_...)")
PY
)" || packages_hint="$PACKAGES_TOKEN could not be checked"
  if [[ -z "$packages_hint" ]]; then
    packages_line="if [ -r $(q "$PACKAGES_TOKEN") ]; then GH_PACKAGES_TOKEN=\"\$(cat -- $(q "$PACKAGES_TOKEN"))\"; export GH_PACKAGES_TOKEN; fi"
  fi
fi

# The launcher, the only file in the directory PATH gets, so the helpers stay
# off PATH; it execs the copy, and never falls through to the real gh. Then the
# zsh startup files. Rewritten whenever what they hold changes, or one is
# missing; the stamp that says they are current is written last.
body="$(body_lines "$GH_DIR" "$ZD" "$bot" "$email" "$helper" "$real_gh")"
stamp="$real_gh"$'\n'"$body"
current=1
for f in "$BIN/gh" "$BIN/mm-gh-org" "$ZD/reassert.zsh" "$ZD/.zshenv" "$ZD/.zprofile" "$ZD/.zshrc" "$ZD/.zlogin" "$ZD/.zlogout" "$SHIM/.installed"; do
  [[ -e "$f" ]] || current=0
done
if [[ $current -eq 0 || "$(<"$SHIM/.installed")" != "$stamp" ]]; then
  { printf '#!/usr/bin/env bash\n# Written by agent-env.sh from commit %s.\n' "$commit"
    printf 'unset MM_GH_ORG\nexec %s %s %s "$@"\n' "$(q "$LIBEXEC/gh-shim.sh")" "$(q "$NAME")" "$(q "$real_gh")"
  } | install_file "$BIN/gh" 700 || locked "cannot write $BIN/gh"
  # mm-gh-org <org> <gh arguments...>: the same gh, with that org's token.
  { printf '#!/usr/bin/env bash\n# Written by agent-env.sh from commit %s.\n' "$commit"
    # shellcheck disable=SC2016 # literal text for the generated script
    printf 'org="${1:-}"; case "$org" in marvinamiranda | ThruuAi) ;; *) echo "usage: mm-gh-org <marvinamiranda|ThruuAi> <gh arguments...>" >&2; exit 2 ;; esac\nshift\n'
    # shellcheck disable=SC2016 # literal text for the generated script
    printf 'MM_GH_ORG="$org" exec %s %s %s "$@"\n' "$(q "$LIBEXEC/gh-shim.sh")" "$(q "$NAME")" "$(q "$real_gh")"
  } | install_file "$BIN/mm-gh-org" 700 || locked "cannot write $BIN/mm-gh-org"
  write_zdotdir "$ZD" "$BIN" "$body" || locked "cannot write the zsh startup files in $ZD"
  printf '%s\n' "$stamp" | install_file "$SHIM/.installed" 600 || locked "cannot write $SHIM/.installed"
fi

# Is that commit on marvinamiranda/.github test, as GitHub has it now (its
# canonical URL, fetched as bootstrap.sh fetches it, into a repository of this
# script's), and are the copies its files there? "Yes" is remembered, as the
# three blob ids that were checked: a commit on test stays there, since the
# test-integration ruleset forbids force pushes, and the copies are only
# trusted while they are those blobs. Any other answer is asked again at the
# next eval, which is cheap enough now that an eval only installs or refreshes
# the identity (the per-command form sources the env file); the fetch has a
# time limit.
provenance() {
  local repo="$STAGE/canonical.git" blobs
  PROVENANCE_PROBLEM=""
  PROVENANCE_TEST=""
  MM_PROVENANCE_TIMEOUT=30 mm_provenance_fetch "$repo"
  if [[ -n "$PROVENANCE_PROBLEM" ]]; then
    echo "marvinamiranda/.github test could not be read, so commit ${commit:0:12} is not known to be merged"
  elif ! mm_scratch_git "$repo" cat-file -e "$commit^{commit}" 2>/dev/null \
      || ! mm_scratch_git "$repo" merge-base --is-ancestor "$commit" "$PROVENANCE_TEST" 2>/dev/null; then
    echo "commit ${commit:0:12} is not on marvinamiranda/.github test (${PROVENANCE_TEST:0:12}): it has not been merged"
  elif ! blobs="$(mm_scratch_git "$repo" rev-parse "$commit:${prefix}agent-env.sh" "$commit:${prefix}gh-shim.sh" "$commit:${prefix}app-token.sh" 2>/dev/null)" \
      || [[ "$blobs" != "$have" ]]; then
    echo "the scripts in $HERE are not the ones commit ${commit:0:12} holds on marvinamiranda/.github test"
  else
    printf '%s\n' "$have" | install_file "$SHIM/on-test" 600 || true
  fi
}
remembered() { [[ -f "$SHIM/on-test" && "$(cat "$SHIM/on-test" 2>/dev/null)" == "$have" ]]; }
on_test=0
if remembered; then
  on_test=1
else
  why="$(provenance)" || why="the commit could not be checked against marvinamiranda/.github test"
  if [[ -n "$why" ]]; then
    echo "agent-env.sh: WARNING: $why. The gh shim and token helper this session runs come from it; eval from a checkout of a merged commit." >&2
  fi
  if remembered; then on_test=1; fi
fi
if [[ -n "${packages_hint:-}" ]]; then
  echo "agent-env.sh: GH_PACKAGES_TOKEN is not set: ${packages_hint}. Package restores from GitHub Packages will fail (README, \"Packages\")." >&2
fi

# The environment, as one script that sets it all up or nothing: the eval runs
# it, and ~/.config/mm-agent/<name>/env holds it for the per-command form,
#   . ~/.config/mm-agent/<name>/env && gh ...
# which a missing file stops. The file is written only for a commit on
# marvinamiranda/.github test, so it only ever runs merged code; an eval from
# anywhere else sets up its own shell and leaves the file as it was. The script
# checks that the shim it names is still there, and fails when it is not.
env_script() {
  cat <<EOF
# Written by agent-env.sh for $NAME; each eval from a merged commit rewrites it.
# Source it at the start of every tool command, joined with &&, so that a
# missing file, or a missing shim, stops the command:
#   . ~/.config/mm-agent/$NAME/env && gh pr create ...
# commit: $commit
if [ -x $(q "$BIN/gh") ] && [ -x $(q "$LIBEXEC/gh-shim.sh") ] && [ -x $(q "$TOKEN_CMD") ] && [ -r $(q "$ZD/reassert.zsh") ]; then
unset GH_TOKEN GITHUB_TOKEN GH_PACKAGES_TOKEN
unset -f gh 2>/dev/null || true; unalias gh 2>/dev/null || true
${packages_line:-: no packages token}
$(owner_zdotdir_lines)
$body
$(path_lines "$BIN")
else
echo $(q "agent-env.sh ($NAME): the gh shim of commit ${commit:0:12} is gone ($SHIM); nothing was set up. Eval agent-env.sh from a checkout of a merged commit to install one.") >&2
unset MM_REAL_GH_BIN
GH_TOKEN=$(q "$SENTINEL"); export GH_TOKEN
false
fi
EOF
}
script="$(env_script)"
ENV_FILE="$DIR/env"
if [[ $on_test -eq 1 ]]; then
  printf '%s\n' "$script" | install_file "$ENV_FILE" 600 \
    || echo "agent-env.sh: WARNING: $ENV_FILE could not be written; the per-command form still runs what it held." >&2
else
  was=""
  if [[ -r "$ENV_FILE" ]]; then was="$(sed -n 's/^# commit: //p' "$ENV_FILE" | head -1)" || was=""; fi
  echo "agent-env.sh: $ENV_FILE not updated, since commit ${commit:0:12} is not known to be on marvinamiranda/.github test: it ${was:+still runs commit ${was:0:12}}${was:-does not exist yet}. This shell is set up all the same." >&2
fi
printf '%s\n' "$script"
PRINTED=1
