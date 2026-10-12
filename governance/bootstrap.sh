#!/usr/bin/env bash
# Bootstrap the delivery standard (DELIVERY §14) for the marvinamiranda organisation.
#
# ANOTHER ORGANISATION (--org ThruuAi): a product repository transferred out of
# marvinamiranda takes its repository rulesets with it, but they must be
# re-asserted, and the organisation's issue types created, against the new
# owner. Run every step below with --org ThruuAi, from the same merged commit of
# marvinamiranda/.github (this repository stays here: provenance is always read
# from marvinamiranda). In another organisation --self-only is refused and this
# repository's own rulesets are never touched, and the Checks App proof must
# come from a check run completed AFTER the transfer (--checks-since <ISO time>):
# a pull request head from before it carries the old organisation's runs and
# proves nothing about the Checks App's installation in the new one.
#   governance/bootstrap.sh --org ThruuAi --repo omni237-ops                                       # dry run
#   governance/bootstrap.sh --org ThruuAi --repo omni237-ops --no-rulesets --probe --apply         # labels, types, env, probe
#   governance/bootstrap.sh --org ThruuAi --repo omni237-ops --checks-since 2026-10-12T15:00:00Z --apply  # rulesets
#
# FIRST, ONCE, straight after this repository's own pull request merges into
# its test, and before any product repository moves its pin to that commit:
#   governance/bootstrap.sh --self-only                   # dry run
#   governance/bootstrap.sh --self-only --probe --apply   # this repository's rulesets
# Until then marvinamiranda/.github, whose code every other repository's
# required checks run, has no ruleset: "on test" means only "pushed".
#
# THEN, FOR EACH PRODUCT REPOSITORY, in this order, and only AFTER its adoption
# pull request has merged into its dev branch: every step reads that
# repository's .github/governance/ from dev (a dry run can read an unmerged one
# with --config-dir). Each run from a merged commit (below):
#   governance/bootstrap.sh --repo omni237 --repo omni237-ops                                # 1. dry run
#   governance/bootstrap.sh --repo omni237 --repo omni237-ops --no-rulesets --apply          # 2. default branch, labels
#   governance/bootstrap.sh --repo omni237 --repo omni237-ops --probe --no-rulesets --apply  # 3. Reviewer App probe
#   4. one Agent App merge into dev: under the rulesets a passing pull request
#      is the only way in, and the Agent App merges agents' ones. Proven for
#      test before the dev cutover: marvinamiranda/omni237-ops#160 was
#      squash-merged into test by app/marvinamiranda-agent (commit 2be0641,
#      2026-09-25 17:52 UTC).
#   governance/bootstrap.sh --repo omni237 --repo omni237-ops --apply                        # 5. rulesets, owner only
# Without --no-rulesets, step 3 would also apply the rulesets in the same run.
#
# RUN IT FROM A MERGED COMMIT: check this repository out by the SHA of a commit
# on its test branch (`git checkout <sha>`). --apply refuses anything else: a
# commit that is not on test as GitHub has it now (read from
# https://github.com/marvinamiranda/.github.git, never from `origin`), a
# checkout with uncommitted changes, or files outside a git checkout. It
# prints the commit it runs from.
#
# DRY RUN BY DEFAULT: only read calls are made, and every call that would
# change something is printed instead. `--apply` executes them. Idempotent:
# each step reads the current state first and changes only what differs.
#
# THE CREDENTIAL FOR --apply: a fine-grained personal access token of the
# owner's, expiring the next day, passed as GH_TOKEN for that run only. Never
# add admin:org to the gh keyring login: agents on this machine can reach that
# login (DELIVERY §9), admin:org can disable the rulesets, and a scope removed
# again with `gh auth refresh --remove-scopes` stays on the token already
# issued (cli/cli#9233). Create it at github.com/settings/personal-access-tokens:
#   Resource owner: marvinamiranda. Expiration: custom, the next day.
#   Repository access: marvinamiranda/.github and each --repo (or all).
#   Organization permissions:
#     Issue Types: read and write      a) Epic, Decision, Spike
#     Projects: read and write         f) only with --project
#   Repository permissions:
#     Actions: read                    g) read the governance-checks environment and its rules
#     Secrets: read                   g) repository and organization NAME metadata only
#     Administration: read and write   b) the default branch; e) rulesets; g) the environment
#     Contents: read                   each repository's .github/governance/ and test
#     Issues: read and write           c) labels
#     Metadata: read                   always included: repositories, ruleset lists
#   d) the probe needs none of these: it posts with the Reviewer App's own token.
#   --self-only needs Administration and Metadata on marvinamiranda/.github alone.
# The organisation may have to approve the token first (its settings, Personal
# access tokens). Pass it without leaving it in the shell history:
#   read -rs GH_TOKEN && export GH_TOKEN       # paste it; nothing is echoed
#   governance/bootstrap.sh ... --apply
#   unset GH_TOKEN
# GitHub reports no permissions for a fine-grained token, so none is checked in
# advance: a step that lacks one fails, and nothing after it runs.
#
# Product structure lives in each product repository, never here (DELIVERY §6):
# it reads .github/governance/{areas.txt, required-checks.txt,
# required-checks.dev.txt, required-checks.main.txt} from each repo's `dev`
# branch, or from --config-dir <dir>/<repo>/ for local testing.
#
# The branch model (DELIVERY §9.1): dev is the integration default every Task
# branches from and merges into; test is acceptance, entered only by a
# promotion from dev; main is production, entered only by a release from test
# or a hotfix branch. Hotfixes are merged back into test the same day.
#
# What it does, in order:
#   a) org issue types Epic, Decision, Spike (Task and Bug must already exist;
#      Feature is left alone)
#   b) per repo: default branch -> dev (closing keywords only act on merges
#      into the default branch, DELIVERY §4)
#   c) per repo: the §11 labels, plus area:* labels from areas.txt
#   d) with --probe: the Reviewer App posts a neutral review/independent check
#      on each repo's test head, proving it can post there before a ruleset
#      pins the check to it
#   e) rulesets `dev-integration`, `test-integration`, `main-owner-only` and
#      `main-checks` on marvinamiranda/.github itself first, then on each repo,
#      created or updated by name (DELIVERY §9, §10); legacy rulesets on dev,
#      test or main are set to enforcement `disabled` (never deleted). They
#      need the Reviewer App's id: without it the run stops before it changes
#      anything. Skipped with --no-rulesets. With --self-only, d) and e) for
#      this repository are all that runs.
#   f) with --project: the Project, its Status/Priority/Size fields, and a link
#      to each repo
#   g) per repo (not with --self-only): the governance-checks environment,
#      which holds the Checks App's key (governance/identity/create-app.py
#      mm-checks). Custom deployment branches with exactly one rule, the branch
#      dev: only default-branch jobs get the key. Any other rule (refs/pull/*,
#      *, a tag) or policy (protected branches, none) is drift: reported in a
#      dry run, removed by --apply. It runs with --no-rulesets too.
#
# What it never does: delete a label, a ruleset, a field, a field option or an
# issue. The one deletion is g)'s drift: a deployment rule that would release
# the Checks App's key to another ref. Anything that exists and is not in the standard is REPORTED so the
# owner can retire it deliberately. Identities are GitHub Apps, created and
# installed by the owner (governance/identity/, DELIVERY Appendix A).
#
# Needs: gh (for --apply, the owner's fine-grained token above), git, jq, and
# bash 3.2 or later.
set -euo pipefail

# PATH first, before any command runs (builtins only up to the `cd /`): --apply
# acts with the owner's token, and a PATH with an empty entry (":$PATH", from
# an unset variable), a relative entry, or one inside this checkout under any
# spelling would find whatever the checkout holds under a command's name
# (gh, jq, mktemp, ...). Refused rather than cleaned: a dirty PATH may already
# have chosen the bash running this. Run it as README "Bootstrap" shows:
#   env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin /bin/bash governance/bootstrap.sh ...
# Then everything runs from /, so no command works in the checkout.
SELF="${BASH_SOURCE[0]}"
[[ "$SELF" == */* ]] || SELF="./$SELF"
SCRIPT_DIR="$(cd "${SELF%/*}" && pwd -P)"
SELF="$SCRIPT_DIR/${SELF##*/}"
# shellcheck source=identity/provenance.sh disable=SC1091
. "$SCRIPT_DIR/identity/provenance.sh"
path_problem="$(mm_provenance_path_problem "$(mm_provenance_top "$SCRIPT_DIR" || true)")"
if [[ -n "$path_problem" ]]; then
  echo "Refusing: $path_problem, so a command could be found in this checkout. Run it with a clean PATH:" >&2
  echo "  env -i HOME=\"\$HOME\" PATH=/opt/homebrew/bin:/usr/bin:/bin /bin/bash $SELF ..." >&2
  exit 1
fi
ORIG_PWD="$PWD"
cd /

# Where this repository lives: provenance and its own rulesets, always.
HOME_ORG="marvinamiranda"
# The organisation configured; --org changes it, from this list only.
ORG="$HOME_ORG"
ALLOWED_ORGS="marvinamiranda ThruuAi"
CHECKS_SINCE=""
APPLY=0
REPOS=()
WANT_PROJECT=0
SKIP_RULESETS=0
SELF_ONLY=0
PROJECT_TITLE=""
PROBE=0
# The one identity that may move main, through a pull request only (DELIVERY
# §9): the owner's user account. `gh api users/rodrigolmiranda --jq .id`.
OWNER_USER_ID=1245936
# This repository. Its own test and main get rulesets too: it holds the code
# every other repository's required checks run.
SELF_REPO=".github"
SELF_CHECKS="governance tests"
CONFIG_DIR=""
# Product configuration is read from the repository's dev branch: dev is the
# integration default (DELIVERY §9.1), the branch every adoption pull request
# merges into and every Task branches from. `.github` itself still integrates
# on test (it has no dev), so --self-only reads nothing.
CONFIG_REF="dev"
STRICT_UP_TO_DATE=false
REVIEWER_APP_ID=""
CHECKS_APP_ID=""
CHECKS_APP_JSON="${MM_CHECKS_APP_JSON:-$HOME/.config/mm-agent/mm-checks/app.json}"
REVIEWER_APP_JSON="${MM_REVIEWER_APP_JSON:-$HOME/.config/mm-agent/mm-reviewer/app.json}"

# GitHub Actions' app id. CI and unchanged dev-integration checks use this
# issuer; pinning the context to it means neither a
# personal token nor another App can satisfy the check. Measured, not assumed:
# `gh api repos/marvinamiranda/omni237/commits/<sha>/check-runs --jq '.check_runs[].app.id'`
# returns 15368 for every check on the last five merged pull requests of
# omni237 and omni237-ops (2026-09-25).
ACTIONS_APP_ID=15368

usage() {
  # The comment block at the top of this file, whatever its length.
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF"
  cat <<EOF

Options:
  --repo <name>            Repository in $ORG to configure. Repeatable. Required,
                           except with --self-only.
  --org <name>             The organisation to configure: one of $ALLOWED_ORGS.
                           Default $HOME_ORG. Another one never touches $HOME_ORG/$SELF_REPO.
  --checks-since <time>    ISO 8601 UTC. Required with --org other than $HOME_ORG when
                           rulesets are applied: the Checks App proof counts only check
                           runs completed at or after it (the transfer time).
  --self-only              Only $HOME_ORG/$SELF_REPO's own rulesets (with --probe, its
                           probe too); takes no --repo. The first run, once this
                           repository's own pull request has merged.
  --apply                  Execute the changes. Without it nothing is written.
  --no-rulesets            Everything except rulesets. Like every step for a product
                           repository it runs after that repository's adoption pull
                           request has merged, since it reads its .github/governance/
                           from $CONFIG_REF. The rulesets follow in a run without it.
  --probe                  Have the Reviewer App post a neutral review/independent
                           check on each repo's test head (needs its key). Pair it
                           with --no-rulesets, or the same run applies the rulesets.
  --project                Also ensure the Project and link the repos to it.
  --project-title <t>      Project title. Required with --project.
  --reviewer-app-id <id>   The Reviewer App's id, which review/independent is pinned to.
                           Default: "id" in $REVIEWER_APP_JSON.
  --checks-app-id <id>     The Checks App id for product test/main issue-link and
                           All checks accounted for. Default: "id" in $CHECKS_APP_JSON.
  --config-dir <dir>       Read <dir>/<repo>/areas.txt etc. instead of the repo's
                           .github/governance/ on $CONFIG_REF (local testing).
  --strict-up-to-date      Require branches to be up to date with the base before merge.
  -h, --help               This text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --repo) [[ $# -ge 2 ]] || { echo "--repo needs a value" >&2; exit 2; }; REPOS+=("$2"); shift ;;
    --project) WANT_PROJECT=1 ;;
    --no-rulesets) SKIP_RULESETS=1 ;;
    --self-only) SELF_ONLY=1 ;;
    --probe) PROBE=1 ;;
    --project-title) [[ $# -ge 2 ]] || { echo "--project-title needs a value" >&2; exit 2; }; PROJECT_TITLE="$2"; shift ;;
    --reviewer-app-id) [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "--reviewer-app-id needs a numeric id" >&2; exit 2; }; REVIEWER_APP_ID="$2"; shift ;;
    --checks-app-id) [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || { echo "--checks-app-id needs a numeric id" >&2; exit 2; }; CHECKS_APP_ID="$2"; shift ;;
    --config-dir) [[ $# -ge 2 ]] || { echo "--config-dir needs a value" >&2; exit 2; }; CONFIG_DIR="$(cd "$ORIG_PWD" && cd "$2" && pwd)"; shift ;;
    --strict-up-to-date) STRICT_UP_TO_DATE=true ;;
    --org) [[ $# -ge 2 ]] || { echo "--org needs a value" >&2; exit 2; }
      case " $ALLOWED_ORGS " in *" $2 "*) ORG="$2" ;; *) echo "--org must be one of: $ALLOWED_ORGS" >&2; exit 2 ;; esac
      shift ;;
    --checks-since) [[ $# -ge 2 && "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
      || { echo "--checks-since needs an ISO 8601 UTC time, e.g. 2026-10-12T15:00:00Z" >&2; exit 2; }
      CHECKS_SINCE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$ORG" != "$HOME_ORG" ]]; then
  (( ! SELF_ONLY )) || { echo "--self-only configures $HOME_ORG/$SELF_REPO, which lives in $HOME_ORG only: no --org $ORG." >&2; exit 2; }
  if (( ! SKIP_RULESETS )) && [[ -z "$CHECKS_SINCE" ]]; then
    echo "--org $ORG with rulesets needs --checks-since <transfer time>: a check run from before the transfer proves nothing about the Checks App in $ORG." >&2
    exit 2
  fi
fi
if (( SELF_ONLY )); then
  [[ ${#REPOS[@]} -eq 0 ]] || { echo "--self-only applies only $ORG/$SELF_REPO's own rulesets: it takes no --repo." >&2; exit 2; }
  (( ! SKIP_RULESETS )) || { echo "--self-only applies rulesets, so --no-rulesets would leave it nothing to do." >&2; exit 2; }
  (( ! WANT_PROJECT )) || { echo "--self-only takes no --project." >&2; exit 2; }
else
  [[ ${#REPOS[@]} -gt 0 ]] || { echo "At least one --repo is required, or --self-only for $ORG/$SELF_REPO's own rulesets." >&2; usage >&2; exit 2; }
fi
if [[ $WANT_PROJECT -eq 1 && -z "$PROJECT_TITLE" ]]; then echo "--project needs --project-title." >&2; exit 2; fi
for r in ${REPOS[@]+"${REPOS[@]}"}; do
  [[ "$r" != "$SELF_REPO" ]] || { echo "$SELF_REPO gets its rulesets automatically; do not pass it as --repo." >&2; exit 2; }
done
command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mm-bootstrap.XXXXXX")"
# Keep the payloads when anything fails, so the call that failed can be read.
on_exit() {
  local rc=$?
  if [[ $rc -eq 0 ]]; then rm -rf "$WORK"; else echo "Exit $rc. Payloads and responses kept in $WORK" >&2; fi
}
trap on_exit EXIT

# ---------------------------------------------------------------- output ----
section() { printf '\n== %s\n' "$*"; }
info()    { printf '   %s\n' "$*"; }
warn()    { printf '   WARNING: %s\n' "$*"; }
PLANNED=0

# Run a mutating command, or print it in a dry run. Arguments are the command.
mutate() {
  PLANNED=$((PLANNED + 1))
  if [[ $APPLY -eq 1 ]]; then
    printf '   APPLY: %s\n' "$(printf '%q ' "$@")"
    "$@"
  else
    printf '   DRY-RUN would run: %s\n' "$(printf '%q ' "$@")"
  fi
}

# Same, for a gh api call with a JSON body in a file; prints the body too.
mutate_json() {
  local method="$1" path="$2" file="$3"
  PLANNED=$((PLANNED + 1))
  if [[ $APPLY -eq 1 ]]; then
    printf '   APPLY: gh api -X %s %s --input %s\n' "$method" "$path" "$file"
    gh api -X "$method" "$path" --input "$file" >/dev/null \
      || { echo "FAILED: $method $path — payload: $file" >&2; exit 1; }
  else
    printf '   DRY-RUN would run: gh api -X %s %s --input - <<JSON\n' "$method" "$path"
    jq . "$file" | sed 's/^/      /'
    printf '      JSON\n'
  fi
}

# Read-only GET into $BODY. Returns 0, or 4 on a 404, and aborts on anything
# else, so a permissions or network failure is never mistaken for "does not
# exist, create it". Call it directly, never inside $(...): the abort and
# $BODY must reach this shell.
BODY=""
fetch() {
  local path="$1"
  if gh api "$path" >"$WORK/body" 2>"$WORK/err"; then
    BODY="$(cat "$WORK/body")"
    return 0
  fi
  BODY=""
  if grep -q 'HTTP 404' "$WORK/err"; then
    return 4
  fi
  echo "GET $path failed:" >&2
  cat "$WORK/err" >&2
  exit 1
}

# Paginated read-only GET of a JSON array, merged into one array.
get_all() {
  gh api --paginate "$1" | jq -s 'add // []'
}

# Non-comment, non-blank lines of a config file.
config_lines() {
  grep -v '^[[:space:]]*#' "$1" | sed 's/[[:space:]]*$//' | grep -v '^[[:space:]]*$' || true
}

# ------------------------------------------------------------- preflight ----
section "Preflight"
if [[ $APPLY -eq 1 ]]; then
  info "Mode: APPLY — changes will be made."
else
  info "Mode: DRY RUN — read calls only; mutating calls are printed."
fi
info "Organisation: $ORG"
if (( SELF_ONLY )); then
  info "Repositories: none (--self-only: only $ORG/$SELF_REPO's own rulesets)"
else
  info "Repositories: ${REPOS[*]}"
fi
if (( SELF_ONLY )); then
  :
elif [[ -n "$CONFIG_DIR" ]]; then
  info "Product config: $CONFIG_DIR/<repo>/ (local override)"
else
  info "Product config: each repo's .github/governance/ on $CONFIG_REF"
fi
# Provenance: --apply runs only from a commit that is on this repository's
# test as GitHub has it now, read from its canonical URL (never from whatever
# `origin` points at), with no uncommitted changes. A commit that only exists
# in this clone, or on a pull request branch, could hold a bypass nobody
# reviewed. Checked before any gh call. The rule is identity/provenance.sh,
# which create-app.py runs too.
# (identity/provenance.sh was sourced at the top.)
mm_provenance "$SCRIPT_DIR" "$WORK"
[[ -z "$PROVENANCE_HEAD" ]] || info "Running from $HOME_ORG/$SELF_REPO commit $PROVENANCE_HEAD"
[[ -n "$PROVENANCE_PROBLEM" ]] || info "That commit is on $HOME_ORG/$SELF_REPO test (read now: ${PROVENANCE_TEST:0:12})."
not_reviewed="$PROVENANCE_PROBLEM"
if [[ -n "$not_reviewed" ]]; then
  if [[ $APPLY -eq 1 ]]; then
    echo "Refusing --apply: $not_reviewed. Check out a merged commit of $HOME_ORG/$SELF_REPO by its SHA." >&2
    exit 1
  fi
  warn "$not_reviewed; --apply would refuse to run."
fi

# The Reviewer App id that review/independent is pinned to. Without it no
# ruleset is applied: this repository's own test-integration would require
# only `governance tests`, which a pull request here can rewrite, and this
# repository's code decides every other repository's checks.
if [[ -z "$REVIEWER_APP_ID" && -r "$REVIEWER_APP_JSON" ]]; then
  REVIEWER_APP_ID="$(jq -r '.id // empty' "$REVIEWER_APP_JSON")"
  [[ "$REVIEWER_APP_ID" =~ ^[0-9]+$ ]] || REVIEWER_APP_ID=""
fi
if [[ -n "$REVIEWER_APP_ID" ]]; then
  info "Reviewer App id: $REVIEWER_APP_ID (review/independent is pinned to it)"
elif (( SKIP_RULESETS )); then
  info "Reviewer App id: none (no ruleset is applied with --no-rulesets)"
else
  {
    echo "No Reviewer App id, so no rulesets: $ORG/$SELF_REPO's own test-integration would require"
    echo "only 'governance tests', which a pull request here can rewrite. Create the Reviewer App"
    echo "(python3 -I -S governance/identity/create-app.py mm-reviewer), then re-run with --reviewer-app-id <id>"
    echo "or with $REVIEWER_APP_JSON present; or run with --no-rulesets."
  } >&2
  exit 1
fi

# Product test/main issuer migration only. Resolve this before ANY ruleset
# write (including this repository's rulesets); self-only output is unchanged.
if (( ! SELF_ONLY && ! SKIP_RULESETS )); then
  if [[ -z "$CHECKS_APP_ID" && -r "$CHECKS_APP_JSON" ]]; then
    CHECKS_APP_ID="$(jq -r '.id // empty' "$CHECKS_APP_JSON")"
    [[ "$CHECKS_APP_ID" =~ ^[1-9][0-9]*$ ]] || CHECKS_APP_ID=""
  fi
  if [[ -z "$CHECKS_APP_ID" ]]; then
    echo "No Checks App id: re-run with --checks-app-id <numeric id> or $CHECKS_APP_JSON present; or use --no-rulesets." >&2
    exit 1
  fi
  if [[ "$CHECKS_APP_ID" == "$REVIEWER_APP_ID" || "$CHECKS_APP_ID" == "$ACTIONS_APP_ID" ]]; then
    echo "Checks App id must differ from Reviewer and Actions ids." >&2
    exit 1
  fi
  published_checks_id="$(gh api apps/marvinamiranda-checks --jq .id)"
  if [[ "$CHECKS_APP_ID" != "$published_checks_id" ]]; then
    echo "Checks App id does not match GET /apps/marvinamiranda-checks." >&2
    exit 1
  fi
  info "Checks App id: $CHECKS_APP_ID (marvinamiranda-checks)"

  # Probe ALL targets before ANY mutation, including this repo's rulesets.
  # Both exact contexts must succeed on ONE recent PR head into test. Shadow
  # names, another App, and evidence split across heads cannot qualify.
  checks_publisher_probe() {
    local repo="$1" prs heads sha runs number updated_at
    prs="$(gh api "repos/$ORG/$repo/pulls?state=all&base=test&sort=updated&direction=desc&per_page=20")" || return 1
    heads="$(jq -er '[.[].head.sha | select(test("^[a-f0-9]{40}$"))] | unique | .[]' <<<"$prs")" || return 1
    while IFS= read -r sha; do
      runs="$(gh api --paginate "repos/$ORG/$repo/commits/$sha/check-runs?per_page=100" | jq -se '[.[] | .check_runs[]]')" || return 1
      if jq -e --argjson id "$CHECKS_APP_ID" --arg sha "$sha" --arg since "$CHECKS_SINCE" '
        [.[] | select(.app.id == $id and .head_sha == $sha and .conclusion == "success"
                      and ($since == "" or (.completed_at // "") >= $since)) | .name] as $names |
        (["governance/issue-link", "All checks accounted for"] - $names | length) == 0
      ' <<<"$runs" >/dev/null; then
        number="$(jq -r --arg sha "$sha" '[.[] | select(.head.sha == $sha)][0].number' <<<"$prs")"
        updated_at="$(jq -r --arg sha "$sha" '[.[] | select(.head.sha == $sha)][0].updated_at' <<<"$prs")"
        info "Checks App publisher proven for $repo on PR #$number head $sha updated_at $updated_at"
        return 0
      fi
    done <<<"$heads"
    return 1
  }
  for repo in "${REPOS[@]}"; do
    if ! checks_publisher_probe "$repo"; then
      if (( APPLY )); then
        echo "Refusing --apply: Checks App publisher for $repo has not successfully posted both exact required contexts on a recent PR head into test. Merge product T5 and observe both successful names before pinning." >&2
        exit 1
      fi
      warn "Checks App publisher for $repo is not proven; --apply would refuse. Merge product T5 and observe both required names before pinning."
    fi
  done
fi

owner_login="$(gh api "user/$OWNER_USER_ID" --jq .login)"
info "main may be moved only by: $owner_login (user id $OWNER_USER_ID), through a pull request"
viewer="$(gh api user --jq .login)"
info "Authenticated as: $viewer"
# Which credential this run uses. No scope is checked: a fine-grained token has
# none, and GitHub reports no permissions for it, so a step that lacks one
# fails, and nothing after it runs (the header lists what each step needs).
if [[ -n "${GH_TOKEN:-}" ]]; then
  if [[ "$GH_TOKEN" == github_pat_* ]]; then
    info "Credential: a fine-grained token, from GH_TOKEN."
  else
    info "Credential: GH_TOKEN."
  fi
elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
  info "Credential: GITHUB_TOKEN."
else
  info "Credential: your gh login."
  if [[ $APPLY -eq 1 ]]; then
    warn "--apply on your gh login, from the keyring. Run it with a one-day fine-grained token as GH_TOKEN instead (--help lists its permissions), and never add admin:org to the keyring login: agents on this machine can reach it, and admin:org can disable the rulesets."
  fi
fi

# Materialise each repo's product config into $WORK/cfg/<repo>/.
load_config() {
  local repo="$1" file="$2" required="$3" dest="$WORK/cfg/$1/$2"
  mkdir -p "$WORK/cfg/$repo"
  if [[ -n "$CONFIG_DIR" ]]; then
    if [[ -f "$CONFIG_DIR/$repo/$file" ]]; then
      cp "$CONFIG_DIR/$repo/$file" "$dest"
      return 0
    fi
  else
    local err="$WORK/cfg-err"
    if gh api -H 'Accept: application/vnd.github.raw' \
        "repos/$ORG/$repo/contents/.github/governance/$file?ref=$CONFIG_REF" >"$dest" 2>"$err"; then
      return 0
    fi
    rm -f "$dest"
    grep -q 'HTTP 404' "$err" || { echo "Reading $repo .github/governance/$file failed:" >&2; cat "$err" >&2; exit 1; }
  fi
  if [[ "$required" == "required" ]]; then
    echo "$ORG/$repo has no .github/governance/$file on $CONFIG_REF${CONFIG_DIR:+ (nor $CONFIG_DIR/$repo/$file)}." >&2
    echo "Adopt the repository first (DELIVERY §14 step 2)." >&2
    exit 1
  fi
  : >"$dest"
}

for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  fetch "repos/$ORG/$repo" || { echo "Repository $ORG/$repo not found" >&2; exit 1; }
  load_config "$repo" areas.txt required
  load_config "$repo" required-checks.txt required
  # required-checks.dev.txt is optional: its absence is a repository that adds
  # no dev-only checks, and the dev ruleset still requires issue-link and the
  # independent review. Reported, never a failure.
  load_config "$repo" required-checks.dev.txt optional
  load_config "$repo" required-checks.main.txt optional
  info "$repo: $(config_lines "$WORK/cfg/$repo/areas.txt" | wc -l | tr -d ' ') areas, $(config_lines "$WORK/cfg/$repo/required-checks.txt" | wc -l | tr -d ' ') required checks on test (+$(config_lines "$WORK/cfg/$repo/required-checks.dev.txt" | wc -l | tr -d ' ') on dev, +$(config_lines "$WORK/cfg/$repo/required-checks.main.txt" | wc -l | tr -d ' ') on main)"
  if [[ "$(config_lines "$WORK/cfg/$repo/required-checks.dev.txt" | wc -l | tr -d ' ')" == "0" ]]; then
    info "$repo: no .github/governance/required-checks.dev.txt; the dev ruleset requires issue-link and review/independent alone."
  fi
done

# ------------------------------------------------------ a) issue types ----
section "a) Organisation issue types"
if (( SELF_ONLY )); then
  info "skipped (--self-only)"
else
fetch "orgs/$ORG/issue-types"
types_json="$BODY"
info "Existing: $(jq -r '[.[] | .name + (if .is_enabled then "" else " (disabled)" end)] | join(", ")' <<<"$types_json")"
for required in Task Bug; do
  if ! jq -e --arg n "$required" 'any(.[]; .name == $n)' <<<"$types_json" >/dev/null; then
    warn "issue type $required does not exist; the $required form will not set a type until it does."
  fi
done
ensure_issue_type() {
  local name="$1" color="$2" description="$3" existing
  existing="$(jq -c --arg n "$name" 'map(select(.name == $n)) | first // empty' <<<"$types_json")"
  if [[ -z "$existing" ]]; then
    jq -n --arg n "$name" --arg c "$color" --arg d "$description" \
      '{name: $n, color: $c, description: $d, is_enabled: true}' >"$WORK/type-$name.json"
    mutate_json POST "orgs/$ORG/issue-types" "$WORK/type-$name.json"
  elif [[ "$(jq -r .is_enabled <<<"$existing")" != "true" ]]; then
    jq -n --arg n "$name" '{name: $n, is_enabled: true}' >"$WORK/type-$name.json"
    mutate_json PUT "orgs/$ORG/issue-types/$(jq -r .id <<<"$existing")" "$WORK/type-$name.json"
  else
    info "$name: present"
  fi
}
ensure_issue_type Epic purple "One capability a user recognises; 3-12 Tasks as sub-issues"
ensure_issue_type Decision orange "A question only the owner may answer (DECISION: <the question>)"
ensure_issue_type Spike green "A time-boxed investigation, at most a day, whose output is a written finding"
fi

# ---------------------------------------------------- b) default branch ----
section "b) Default branch"
(( ! SELF_ONLY )) || info "skipped (--self-only)"
for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  fetch "repos/$ORG/$repo"
  current_default="$(jq -r .default_branch <<<"$BODY")"
  if [[ "$current_default" == "$CONFIG_REF" ]]; then
    info "$repo: $CONFIG_REF"
    continue
  fi
  # The cutover point: dev must exist before the default branch moves to it.
  fetch "repos/$ORG/$repo/branches/$CONFIG_REF" || { warn "$repo has no $CONFIG_REF branch; default branch left as '$current_default'."; continue; }
  info "$repo: '$current_default' -> '$CONFIG_REF'. Closing keywords only act on merges into the default branch (DELIVERY §4); workflow_run and schedule workflows will run $CONFIG_REF's copies."
  jq -n --arg b "$CONFIG_REF" '{default_branch: $b}' >"$WORK/default-$repo.json"
  mutate_json PATCH "repos/$ORG/$repo" "$WORK/default-$repo.json"
done

# ---------------------------------------------------------- c) labels ----
# name|color|description — DELIVERY §11. archived-<date> is created by a reset, not here.
STANDARD_LABELS=(
  "tier:mechanical|0e8a16|Copies an existing golden example; no design choice left"
  "tier:standard|fbca04|Ordinary multi-file work with normal engineering judgement"
  "tier:senior|b60205|Touches a risk surface; needs a second, adversarial review"
  "security|d93f0b|Security-relevant; adversarial review before merge"
  "later|cfd3d7|Not in any milestone; revisit at planning"
  "needs-owner|5319e7|Waiting on the owner; see the linked Decision issue"
)
AREA_COLOR="1d76db"

section "c) Labels"
(( ! SELF_ONLY )) || info "skipped (--self-only)"
for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  info "[$repo]"
  current="$(get_all "repos/$ORG/$repo/labels?per_page=100")"
  wanted="$WORK/labels-$repo.tsv"
  : >"$wanted"
  for spec in "${STANDARD_LABELS[@]}"; do
    printf '%s\n' "$spec" >>"$wanted"
  done
  while IFS= read -r line; do
    name="${line%%|*}"
    desc="${line#*|}"
    [[ "$line" == *"|"* ]] || { echo "Malformed line in $repo .github/governance/areas.txt: $line" >&2; exit 1; }
    [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "Area name must be lower-case kebab: $name" >&2; exit 1; }
    [[ ${#desc} -le 100 ]] || { echo "Area description over 100 characters (GitHub limit): $name" >&2; exit 1; }
    printf 'area:%s|%s|%s\n' "$name" "$AREA_COLOR" "$desc" >>"$wanted"
  done < <(config_lines "$WORK/cfg/$repo/areas.txt")

  while IFS='|' read -r name color desc; do
    have="$(jq -c --arg n "$name" 'map(select((.name | ascii_downcase) == ($n | ascii_downcase))) | first // empty' <<<"$current")"
    if [[ -z "$have" ]]; then
      mutate gh label create "$name" -R "$ORG/$repo" --color "$color" --description "$desc"
    elif [[ "$(jq -r '.color | ascii_downcase' <<<"$have")" != "$color" || "$(jq -r '.description // ""' <<<"$have")" != "$desc" || "$(jq -r .name <<<"$have")" != "$name" ]]; then
      mutate gh label edit "$(jq -r .name <<<"$have")" -R "$ORG/$repo" --name "$name" --color "$color" --description "$desc"
    else
      info "  $name: present"
    fi
  done <"$wanted"

  extras="$(jq -r --rawfile w "$wanted" '
      ($w | split("\n") | map(select(length > 0) | split("|")[0] | ascii_downcase)) as $want
      | map(.name) | map(select((ascii_downcase | IN($want[]) | not) and (startswith("archived-") | not))) | .[]' <<<"$current")"
  if [[ -n "$extras" ]]; then
    info "  Not in DELIVERY §11 (reported, never deleted by this script): $(tr '\n' ' ' <<<"$extras")"
  fi
done

# -------------------------------------------------------- d) rulesets ----
# required_status_checks entries: every Actions check pinned to the Actions app,
# plus review/independent pinned to the Reviewer App when its id is known.
required_checks_json() {
  # $1: review | none
  # $2: extra check contexts, space-separated, or "none"
  # $3: issuer for the two Checks App contexts (Actions for self/dev)
  # $4...: check list files
  local with_review="$1" extra="$2" checks_app="$3"; shift 3
  {
    for f in "$@"; do config_lines "$f"; done
    if [[ "$extra" != "none" ]]; then for c in $extra; do echo "$c"; done; fi
  } | awk '!seen[$0]++' | jq -R -s --argjson app "$ACTIONS_APP_ID" --argjson checks_app "$checks_app" '
      split("\n") | map(select(length > 0) | {context: ., integration_id: (if . == "governance/issue-link" or . == "All checks accounted for" then $checks_app else $app end)})' >"$WORK/checks.json"
  if [[ "$with_review" == "review" && -n "$REVIEWER_APP_ID" ]]; then
    jq --argjson rid "$REVIEWER_APP_ID" '. + [{context: "review/independent", integration_id: $rid}]' "$WORK/checks.json"
  else
    cat "$WORK/checks.json"
  fi
}

# dev-integration (DELIVERY §9.1): the integration default. Pull request, no
# approvals (the review is the pinned review/independent check), no force push,
# no deletion, no bypass for anyone, merge commits only. Any branch may open a
# pull request into dev; the dev checks are the repository's
# required-checks.dev.txt (optional) plus governance/issue-link.
dev_ruleset() {
  jq -n --argjson checks "$1" --argjson strict "$STRICT_UP_TO_DATE" '{
    name: "dev-integration", target: "branch", enforcement: "active",
    bypass_actors: [],
    conditions: {ref_name: {include: ["refs/heads/dev"], exclude: []}},
    rules: [
      {type: "deletion"},
      {type: "non_fast_forward"},
      {type: "pull_request", parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false, require_last_push_approval: false,
        required_review_thread_resolution: false,
        require_extra_approval_for_unattributed_changes: false,
        allowed_merge_methods: ["merge"]}},
      {type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: $strict, do_not_enforce_on_create: false,
        required_status_checks: $checks}}
    ]}'
}

# test-integration (DELIVERY §9.1): acceptance, entered only by a promotion
# from dev, a hotfix branch, or the hotfix back-merge from main (the
# test-source-policy check enforces the sources). Pull request, no approvals
# (the review is the pinned review/independent check), required checks, no
# force push, no deletion, no bypass for anyone, merge commits only so test and
# main keep one history. A ruleset cannot tie a merge method to a head branch:
# that one is procedural.
test_ruleset() {
  jq -n --argjson checks "$1" --argjson strict "$STRICT_UP_TO_DATE" '{
    name: "test-integration", target: "branch", enforcement: "active",
    bypass_actors: [],
    conditions: {ref_name: {include: ["refs/heads/test"], exclude: []}},
    rules: [
      {type: "deletion"},
      {type: "non_fast_forward"},
      {type: "pull_request", parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false, require_last_push_approval: false,
        required_review_thread_resolution: false,
        require_extra_approval_for_unattributed_changes: false,
        allowed_merge_methods: ["merge"]}},
      {type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: $strict, do_not_enforce_on_create: false,
        required_status_checks: $checks}}
    ]}'
}

# main is guarded by TWO rulesets, split so that the owner's bypass cannot
# reach the checks (DELIVERY §9). A bypass actor bypasses every rule of the
# ruleset it is listed on, so the one bypass lives alone:
#
# main-owner-only: nobody may update main except the owner's own account, and
# only through a pull request — `update` (restrict updates) with that one user
# as the only bypass, in pull_request mode. Nothing else. A user, not the
# organisation-admin role: the role would extend to any future admin, and to
# anything acting with an admin's credentials.
main_owner_ruleset() {
  jq -n --argjson owner "$OWNER_USER_ID" '{
    name: "main-owner-only", target: "branch", enforcement: "active",
    bypass_actors: [{actor_id: $owner, actor_type: "User", bypass_mode: "pull_request"}],
    conditions: {ref_name: {include: ["refs/heads/main"], exclude: []}},
    rules: [
      {type: "update", parameters: {update_allows_fetch_and_merge: false}}
    ]}'
}

# main-checks: what every change to main must pass, the owner's included —
# no bypass. Merge commits only: releases squashed onto main left test and main
# with different histories, and omni237-ops pull requests 113, 115, 118, 121
# and 126 were spent re-syncing them ("MERGE WITH A MERGE COMMIT — … stop this
# recurring").
main_checks_ruleset() {
  jq -n --argjson checks "$1" --argjson strict "$STRICT_UP_TO_DATE" '{
    name: "main-checks", target: "branch", enforcement: "active",
    bypass_actors: [],
    conditions: {ref_name: {include: ["refs/heads/main"], exclude: []}},
    rules: [
      {type: "deletion"},
      {type: "non_fast_forward"},
      {type: "pull_request", parameters: {
        required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false, require_last_push_approval: false,
        required_review_thread_resolution: false,
        require_extra_approval_for_unattributed_changes: false,
        allowed_merge_methods: ["merge"]}},
      {type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: $strict, do_not_enforce_on_create: false,
        required_status_checks: $checks}}
    ]}'
}

# Normalises a ruleset (desired or fetched) so the two can be diffed. Merge
# methods compare as a set; a pull request rule without them allows all three,
# as GitHub does.
normalise_ruleset() {
  jq -S '{name, target, enforcement,
          bypass_actors: (.bypass_actors // [] | map({actor_id, actor_type, bypass_mode}) | sort_by(.actor_type, .actor_id)),
          conditions: {ref_name: .conditions.ref_name},
          rules: (.rules | map(
            if .type == "pull_request" then {type, parameters: (.parameters | {required_approving_review_count, dismiss_stale_reviews_on_push, require_code_owner_review, require_last_push_approval, required_review_thread_resolution, require_extra_approval_for_unattributed_changes: (.require_extra_approval_for_unattributed_changes // false), allowed_merge_methods: (.allowed_merge_methods // ["merge", "squash", "rebase"] | unique)})}
            elif .type == "required_status_checks" then {type, parameters: (.parameters | {strict_required_status_checks_policy, do_not_enforce_on_create: (.do_not_enforce_on_create // false), required_status_checks: (.required_status_checks | map({context} + (if .integration_id then {integration_id} else {} end)) | sort_by(.context))})}
            elif .type == "update" then {type, parameters: {update_allows_fetch_and_merge: (.parameters.update_allows_fetch_and_merge // false)}}
            else {type} end) | sort_by(.type))}'
}

# ------------------------------------------------------------ d) probe ----
# The Reviewer App posts a neutral review/independent check on each repo's test
# head, so the check context has been seen from that App before a ruleset pins
# it — and so a missing installation is found now, not by the first blocked PR.
section "d) Reviewer App probe"
if (( PROBE )); then
  if [[ -z "$REVIEWER_APP_ID" ]]; then
    warn "no Reviewer App id; nothing to probe."
  else
    PROBE_REPOS=(${REPOS[@]+"${REPOS[@]}"})
    [[ "$ORG" != "$HOME_ORG" ]] || PROBE_REPOS+=("$SELF_REPO")
    for repo in "${PROBE_REPOS[@]}"; do
      fetch "repos/$ORG/$repo/branches/test" || { warn "$repo has no test branch; not probed."; continue; }
      head_sha="$(jq -r .commit.sha <<<"$BODY")"
      jq -n --arg sha "$head_sha" '{name: "review/independent", head_sha: $sha, status: "completed",
        conclusion: "neutral", output: {title: "Probe: the Reviewer App can post here",
        summary: "Posted by governance/bootstrap.sh --probe before the rulesets pin review/independent to this App. It reviews nothing."}}' \
        >"$WORK/probe-$repo.json"
      PLANNED=$((PLANNED + 1))
      if [[ $APPLY -eq 1 ]]; then
        printf '   APPLY: as the Reviewer App: POST repos/%s/%s/check-runs on test %s\n' "$ORG" "$repo" "${head_sha:0:12}"
        reviewer_token="$("$SCRIPT_DIR/identity/app-token.sh" mm-reviewer)"
        GH_TOKEN="$reviewer_token" gh api -X POST "repos/$ORG/$repo/check-runs" --input "$WORK/probe-$repo.json" \
          --jq '"   posted by app \(.app.id) (\(.app.slug))"' \
          || { echo "FAILED: probe on $repo — payload: $WORK/probe-$repo.json" >&2; exit 1; }
      else
        printf '   DRY-RUN would post, as the Reviewer App (%s): review/independent=neutral on %s test %s\n' "$REVIEWER_APP_ID" "$repo" "${head_sha:0:12}"
      fi
    done
  fi
else
  info "skipped (pass --probe)"
fi

# --------------------------------------------------------- e) rulesets ----
section "e) Rulesets"
# --no-rulesets: everything but the rulesets, so that the Reviewer App probe and
# one Agent App merge into dev are proven before the rulesets make a passing
# pull request the only way in.
# This repository first: it holds the code every other repository's checks run.
if (( SKIP_RULESETS )); then info "skipped (--no-rulesets)"; RULESET_REPOS=()
elif [[ "$ORG" != "$HOME_ORG" ]]; then RULESET_REPOS=(${REPOS[@]+"${REPOS[@]}"}); info "$HOME_ORG/$SELF_REPO's own rulesets are not touched from --org $ORG."
else RULESET_REPOS=("$SELF_REPO" ${REPOS[@]+"${REPOS[@]}"}); fi
OURS=" dev-integration test-integration main-owner-only main-checks "
for repo in ${RULESET_REPOS[@]+"${RULESET_REPOS[@]}"}; do
  info "[$repo]"
  existing="$(get_all "repos/$ORG/$repo/rulesets?includes_parents=true&per_page=100")"
  info "Existing rulesets (as they are now):"
  if [[ "$(jq length <<<"$existing")" -eq 0 ]]; then
    info "  none"
  fi
  : >"$WORK/legacy-$repo"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    fetch "repos/$ORG/$repo/rulesets/$id"
    detail="$BODY"
    jq '{id, name, source_type, enforcement, conditions, bypass_actors, rules}' <<<"$detail" | sed 's/^/      /'
    rs_name="$(jq -r .name <<<"$detail")"
    case "$OURS" in *" $rs_name "*) continue ;; esac
    # A repository ruleset of ours-to-replace: active on dev, test or main.
    if jq -e '.source_type == "Repository" and .enforcement != "disabled"
        and ([.conditions.ref_name.include[]?] | any(. == "refs/heads/dev" or . == "refs/heads/test" or . == "refs/heads/main" or . == "~DEFAULT_BRANCH" or . == "~ALL"))' \
        <<<"$detail" >/dev/null; then
      printf '%s\t%s\n' "$id" "$rs_name" >>"$WORK/legacy-$repo"
    fi
  done < <(jq -r '.[].id' <<<"$existing")

  payloads=()
  if [[ "$repo" == "$SELF_REPO" ]]; then
    # This repository integrates on test (it has no dev) and runs no PR
    # governance on itself; its own tests are the check, so no dev ruleset and
    # no source-policy or issue-link context.
    printf '%s\n' "$SELF_CHECKS" >"$WORK/self-checks.txt"
    test_ruleset "$(required_checks_json review none "$ACTIONS_APP_ID" "$WORK/self-checks.txt")" >"$WORK/rs-test-$repo.json"
    main_checks_ruleset "$(required_checks_json none none "$ACTIONS_APP_ID" "$WORK/self-checks.txt")" >"$WORK/rs-main-checks-$repo.json"
    payloads=("$WORK/rs-test-$repo.json" "$WORK/rs-main-owner-$repo.json" "$WORK/rs-main-checks-$repo.json")
  else
    cfg="$WORK/cfg/$repo"
    # dev gets the repository's optional dev checks, issue-link, and the
    # independent review; test adds the source policy and the full test checks;
    # main adds the source policy, issue-link and the main-only checks.
    dev_ruleset "$(required_checks_json review "governance/issue-link" "$ACTIONS_APP_ID" "$cfg/required-checks.dev.txt")" >"$WORK/rs-dev-$repo.json"
    test_ruleset "$(required_checks_json review "test-source-policy governance/issue-link" "$CHECKS_APP_ID" "$cfg/required-checks.txt")" >"$WORK/rs-test-$repo.json"
    main_checks_ruleset "$(required_checks_json none "main-source-policy governance/issue-link" "$CHECKS_APP_ID" "$cfg/required-checks.txt" "$cfg/required-checks.main.txt")" >"$WORK/rs-main-checks-$repo.json"
    payloads=("$WORK/rs-dev-$repo.json" "$WORK/rs-test-$repo.json" "$WORK/rs-main-owner-$repo.json" "$WORK/rs-main-checks-$repo.json")
  fi
  main_owner_ruleset >"$WORK/rs-main-owner-$repo.json"

  for payload in "${payloads[@]}"; do
    name="$(jq -r .name "$payload")"
    id="$(jq -r --arg n "$name" 'map(select(.name == $n and .source_type == "Repository")) | first | .id // empty' <<<"$existing")"
    if [[ -z "$id" ]]; then
      info "Ruleset $name: absent — will be created."
      mutate_json POST "repos/$ORG/$repo/rulesets" "$payload"
    else
      fetch "repos/$ORG/$repo/rulesets/$id"
      normalise_ruleset <<<"$BODY" >"$WORK/have.json"
      normalise_ruleset <"$payload" >"$WORK/want.json"
      if diff -q "$WORK/have.json" "$WORK/want.json" >/dev/null; then
        info "Ruleset $name: up to date."
      else
        info "Ruleset $name (id $id) differs:"
        diff -u "$WORK/have.json" "$WORK/want.json" | sed 's/^/      /' || true
        mutate_json PUT "repos/$ORG/$repo/rulesets/$id" "$payload"
      fi
    fi
  done

  # Only after ours exist: legacy rulesets on test or main are disabled, never
  # deleted, so their history and settings stay readable.
  while IFS="$(printf '\t')" read -r id rs_name; do
    [[ -n "$id" ]] || continue
    warn "legacy ruleset '$rs_name' (id $id) on test/main: set to enforcement disabled (not deleted)."
    printf '{"enforcement":"disabled"}\n' >"$WORK/disable-$repo-$id.json"
    mutate_json PUT "repos/$ORG/$repo/rulesets/$id" "$WORK/disable-$repo-$id.json"
  done <"$WORK/legacy-$repo"
done

# --------------------------------------------------------- f) project ----
if [[ $WANT_PROJECT -eq 1 ]]; then
  section "f) Project \"$PROJECT_TITLE\""
  projects="$(gh project list --owner "$ORG" --limit 200 --format json)"
  number="$(jq -r --arg t "$PROJECT_TITLE" '[.projects[] | select(.title == $t and (.closed | not))] | first | .number // empty' <<<"$projects")"
  created=0
  if [[ -z "$number" ]]; then
    info "Project absent — will be created."
    if [[ $APPLY -eq 1 ]]; then
      PLANNED=$((PLANNED + 1))
      printf '   APPLY: gh project create --owner %s --title %q\n' "$ORG" "$PROJECT_TITLE"
      number="$(gh project create --owner "$ORG" --title "$PROJECT_TITLE" --format json | jq -r .number)"
      created=1
    else
      mutate gh project create --owner "$ORG" --title "$PROJECT_TITLE"
    fi
  else
    info "Project #$number exists: https://github.com/orgs/$ORG/projects/$number"
  fi

  # name|options (comma-separated, in order)|colours for Status options
  STATUS_OPTIONS="Backlog,Ready,In progress,In review,Done"
  FIELD_SPECS=("Priority|P0,P1,P2" "Size|S,M,L")

  if [[ -n "$number" ]]; then
    fields="$(gh project field-list "$number" --owner "$ORG" --limit 100 --format json)"
    field_opts() { jq -r --arg n "$1" '.fields[] | select(.name == $n) | [.options[]?.name] | join(",")' <<<"$fields"; }

    have_status="$(field_opts Status)"
    if [[ "$have_status" == "$STATUS_OPTIONS" ]]; then
      info "Status: $have_status"
    elif [[ $created -eq 1 ]]; then
      # A project created by this run has no items, so replacing the options clears nothing.
      status_id="$(jq -r '.fields[] | select(.name == "Status") | .id' <<<"$fields")"
      # shellcheck disable=SC2016  # GraphQL variables, not shell
      mutate gh api graphql -f query='mutation($f:ID!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:[
        {name:"Backlog",color:GRAY,description:"Written, not yet meeting Ready"},
        {name:"Ready",color:BLUE,description:"Meets the Definition of Ready"},
        {name:"In progress",color:YELLOW,description:"Assigned; a branch exists"},
        {name:"In review",color:PURPLE,description:"Pull request open, not draft"},
        {name:"Done",color:GREEN,description:"Merged to test"}]}){projectV2Field{... on ProjectV2SingleSelectField{name}}}}' -f f="$status_id"
    else
      warn "Status options are '$have_status', the standard is '$STATUS_OPTIONS'. NOT changed: replacing single-select options clears the Status of every item holding a removed option. Map the items first, then change the options — an owner decision."
    fi

    for spec in "${FIELD_SPECS[@]}"; do
      fname="${spec%%|*}"
      fopts="${spec#*|}"
      have="$(field_opts "$fname")"
      if ! jq -e --arg n "$fname" 'any(.fields[]; .name == $n)' <<<"$fields" >/dev/null; then
        mutate gh project field-create "$number" --owner "$ORG" --name "$fname" --data-type SINGLE_SELECT --single-select-options "$fopts"
      elif [[ "$have" == "$fopts" ]]; then
        info "$fname: $have"
      else
        warn "$fname options are '$have', the standard is '$fopts'. NOT changed, for the same reason as Status."
      fi
    done

    extra_fields="$(jq -r '[.fields[].name | select(length > 0) | select(IN("Title","Assignees","Status","Labels","Linked pull requests","Milestone","Repository","Reviewers","Parent issue","Sub-issues progress","Created","Updated","Closed","Tracks","Tracked by","Type","Priority","Size") | not)] | join(", ")' <<<"$fields")"
    [[ -z "$extra_fields" ]] || info "Custom fields not in DELIVERY §11 (reported, not deleted): $extra_fields"

    # shellcheck disable=SC2016  # GraphQL variables, not shell
    linked="$(gh api graphql -f query='query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){repositories(first:100){nodes{name}}}}}' -f o="$ORG" -F n="$number" --jq '[.data.organization.projectV2.repositories.nodes[].name]')"
    for repo in ${REPOS[@]+"${REPOS[@]}"}; do
      if jq -e --arg r "$repo" 'index($r) != null' <<<"$linked" >/dev/null; then
        info "$repo: linked"
      else
        mutate gh project link "$number" --owner "$ORG" --repo "$ORG/$repo"
      fi
    done
  else
    info "Fields: Status ($STATUS_OPTIONS), Priority (P0,P1,P2), Size (S,M,L) would be set on the new project."
    for repo in ${REPOS[@]+"${REPOS[@]}"}; do
      info "DRY-RUN would run: gh project link <new> --owner $ORG --repo $ORG/$repo"
    done
  fi
  info "Views (Frontier, By milestone, By Epic, In flight, Decisions) are not managed here: POST orgs/$ORG/projectsV2/<n>/views creates them once."
fi

# ------------------------------------ g) the governance-checks environment ----
# The Checks App's private key lives only in this environment's secret
# (marvinamiranda/.github#9), so which refs may use the environment decides who
# can post the merge-gating checks. Only jobs on the default branch, dev:
# a custom deployment-branch policy (never "protected branches", which admits
# every protected branch, nor none, which admits every ref) whose one rule is
# the branch `dev`. Any other rule, `refs/pull/*`, `*` or a tag, would release
# the key to that ref: it is drift, reported, and removed by --apply (the one
# thing this script deletes, since keeping it is the hole). Drift goes before
# the rule is added, so a failure part way leaves fewer refs allowed, not more.
# create-app.py mm-checks --to-environment checks the same shape before it
# creates the App.
CHECKS_ENV="governance-checks"
CHECKS_ENV_BRANCH="$CONFIG_REF"
# Read NAME metadata only. Permission/network/malformed/truncated responses
# never prove absence, and drift is reported for owner remediation only.
check_broad_checks_key() { # <endpoint> <scope label>
  local endpoint="$1" scope="$2" metadata="$WORK/secret-metadata.json"
  if ! gh api --paginate "$endpoint" >"$metadata" 2>"$WORK/secret-metadata.err"; then
    warn "UNVERIFIED: $scope Checks App key placement metadata is unreadable; no absence claim."
    return 1
  fi
  if ! jq -se '
    length > 0 and all(.[];
      type == "object" and (.total_count | type == "number") and .total_count >= 0
      and (.secrets | type == "array") and all(.secrets[]; (.name | type == "string")))
    and (.[0].total_count as $count |
      all(.[]; .total_count == $count) and
      ([.[] | .secrets[].name] | length == $count and (unique | length) == $count))
  ' "$metadata" >/dev/null 2>&1; then
    warn "UNVERIFIED: $scope Checks App key placement metadata is malformed or incomplete; no absence claim."
    return 1
  fi
  if jq -se '[.[] | .secrets[].name] | index("CHECKS_APP_PRIVATE_KEY") != null' "$metadata" >/dev/null; then
    warn "DRIFT: $scope CHECKS_APP_PRIVATE_KEY exists outside governance-checks; owner remediation required, secret is not changed."
    return 1
  fi
  return 0
}

section "g) Environment $CHECKS_ENV"
(( ! SELF_ONLY )) || info "skipped (--self-only)"
for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  info "[$repo]"
  checks_key_placement_verified=1
  check_broad_checks_key "repos/$ORG/$repo/actions/secrets?per_page=100" "repository $repo" || checks_key_placement_verified=0
  check_broad_checks_key "orgs/$ORG/actions/secrets?per_page=100" "organization $ORG" || checks_key_placement_verified=0
  env_path="repos/$ORG/$repo/environments/$CHECKS_ENV"
  fetch "repos/$ORG/$repo"
  current_default="$(jq -r .default_branch <<<"$BODY")"
  if [[ "$current_default" != "$CHECKS_ENV_BRANCH" ]]; then
    # In a dry run b) above would make test the default; after --apply it has.
    if [[ $APPLY -eq 0 ]] && fetch "repos/$ORG/$repo/branches/$CHECKS_ENV_BRANCH"; then
      info "default branch '$current_default'; b) makes it '$CHECKS_ENV_BRANCH', the one ref $CHECKS_ENV allows."
    else
      warn "$repo's default branch is '$current_default', not $CHECKS_ENV_BRANCH: $CHECKS_ENV not created or changed, so the Checks App's key cannot be loaded into it."
      continue
    fi
  fi
  jq -n '{deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}}' >"$WORK/env-$repo.json"
  planned_before=$PLANNED
  env_put=0
  if fetch "$env_path"; then
    have_policy="$(jq -c '.deployment_branch_policy | if . == null then null else {protected_branches, custom_branch_policies} end' <<<"$BODY")"
    if [[ "$have_policy" == '{"protected_branches":false,"custom_branch_policies":true}' ]]; then
      info "$CHECKS_ENV: exists, custom deployment branches."
    else
      warn "DRIFT: $CHECKS_ENV deployment branches are $have_policy (null: every ref); wants custom branch policies only."
      mutate_json PUT "$env_path" "$WORK/env-$repo.json"
      env_put=1
    fi
  else
    info "$CHECKS_ENV: absent — will be created."
    mutate_json PUT "$env_path" "$WORK/env-$repo.json"
    env_put=1
  fi

  # The rules. After a PUT in a dry run they cannot be read yet: none are assumed.
  rules='[]'
  if (( ! env_put || APPLY )); then
    if fetch "$env_path/deployment-branch-policies?per_page=100"; then
      rules="$(jq -c '.branch_policies // []' <<<"$BODY")"
      if [[ "$(jq -r '.total_count // 0' <<<"$BODY")" != "$(jq -r length <<<"$rules")" ]]; then
        echo "$repo $CHECKS_ENV lists $(jq -r '.total_count' <<<"$BODY") deployment rules but returned $(jq -r length <<<"$rules"); fix them by hand first." >&2
        exit 1
      fi
    elif (( APPLY )); then
      echo "$repo $CHECKS_ENV: its deployment rules cannot be read after the PUT." >&2
      exit 1
    fi
  fi
  kept=0
  while IFS="$(printf '\t')" read -r rule_id rule_name rule_type; do
    [[ -n "$rule_id" ]] || continue
    if [[ "$rule_name" == "$CHECKS_ENV_BRANCH" && "$rule_type" == "branch" && $kept -eq 0 ]]; then
      info "rule '$rule_name' ($rule_type): kept."
      kept=1
    else
      warn "DRIFT: rule '$rule_name' ($rule_type, id $rule_id) would release the Checks App's key to that ref; removed by --apply."
      mutate gh api -X DELETE "$env_path/deployment-branch-policies/$rule_id" --silent
    fi
  done < <(jq -r '.[] | [.id, .name, (.type // "")] | @tsv' <<<"$rules")
  if (( ! kept )); then
    jq -n --arg b "$CHECKS_ENV_BRANCH" '{name: $b, type: "branch"}' >"$WORK/env-rule-$repo.json"
    mutate_json POST "$env_path/deployment-branch-policies" "$WORK/env-rule-$repo.json"
  fi
  (( PLANNED != planned_before || ! checks_key_placement_verified )) || info "$CHECKS_ENV: up to date."

done

section "Summary"
if [[ $APPLY -eq 1 ]]; then
  info "$PLANNED change(s) applied."
else
  info "$PLANNED change(s) planned. Nothing was written. Re-run with --apply to make them."
fi
