# Organisation GitHub defaults

The shared assets of the organisation's delivery standard
(`01 - Governance/DELIVERY.md` in the MarvinaMiranda knowledge repository, §14).
The issue forms and pull request template are the organisation default: they
apply to every repository that does not provide its own, immediately. Rulesets,
`AGENTS.md` and areas are adopted per repository, at that repository's reset.

This repository is public, so product structure (areas, required checks, hot
shared files) lives in each product repository under `.github/governance/`
(DELIVERY §6). Product names appear here only as examples.

**Every change here is `tier:senior` and needs an adversarial review**, and so
does any change to `.github/**` in an adopted repository, or to any script a job
with `checks: write` or a `workflow_run` trigger executes. The code in this
repository decides every other repository's required checks, and the Agent App
holds `workflows: write`.

| Asset | Path |
|---|---|
| Issue forms: Epic, Task, Bug, Decision, Spike | `.github/ISSUE_TEMPLATE/` |
| Pull request template | `.github/pull_request_template.md` |
| Reusable PR governance workflow (`governance/issue-link`, areas check) | `.github/workflows/pr-governance.yml` |
| Reusable source-policy workflow (`test-source-policy`, `main-source-policy`) | `.github/workflows/source-policy.yml` |
| Reusable workflow that publishes `governance/issue-link` as the Checks App, from a caller's `workflow_run` job | `.github/workflows/issue-link-publish.yml` |
| Issue-link matcher and its tests | `governance/issue-link.js`, `governance/tests/issue-link.test.js` |
| Source-policy matcher and its tests | `governance/source-policy.js`, `governance/tests/source-policy.test.js` |
| Areas checker and its tests | `governance/areas-check.js`, `governance/tests/areas-check.test.js` |
| How to find and prefactor hot shared files | `governance/HOTSPOTS-GUIDE.md` |
| Bootstrap: issue types, default branch, labels, rulesets, Project, the `governance-checks` environment | `governance/bootstrap.sh` |
| Agent identities: App manifests, creation, tokens, the agent shell's `gh` shim, posting a review | `governance/identity/` |
| Tests of the workflows' pin checks and key custody, the bootstrap and the identity scripts | `governance/tests/` |

The issue forms set native issue types. Epic, Decision and Spike must exist as
organisation issue types first — run the bootstrap before these forms reach
the default branch, or those three forms open issues with no type.

## What an adopted repository carries

```text
.github/governance/areas.txt                 areas, as label lines plus path globs
.github/governance/required-checks.txt       CI checks required on test and main
.github/governance/required-checks.dev.txt   extra checks required on dev only (optional)
.github/governance/required-checks.main.txt  extra checks required on main only
.github/governance/HOTSPOTS.md               its hot shared files (see HOTSPOTS-GUIDE.md)
.github/workflows/pr-governance.yml          the caller below
.github/workflows/source-policy.yml          the source-policy caller below
AGENTS.md                                    the repository's agent rules (root)
```

**Agent instructions (owner decision 2026-10-10).** Every product repository
keeps exactly one `AGENTS.md` at its root and no `CLAUDE.md`: Claude Code and
Codex both load `AGENTS.md` natively. `AGENTS.md` holds only that repository's
rules; owner-wide rules live in the owner's global `AGENTS.md` and are not
duplicated per repository. No governance script, check or template in this
repository requires or reads a `CLAUDE.md`.

The branch model (DELIVERY §9.1): **`dev`** is the default and the integration
branch every Task branches from and merges into; **`test`** is acceptance,
entered only by a promotion from `dev`; **`main`** is production, entered only
by a release from `test` or a `hotfix/*`. The source is enforced by the
`test-source-policy` check on `test` and the `main-source-policy` check on
`main` (`.github/workflows/source-policy.yml`), and every branch moves by merge
commits only. **Into `test` or `main` the pull request must also come from the
same repository**: a fork can name a branch `dev`, `main` or `hotfix/*`, so the
check compares GitHub's own base and head repository full names with this
repository and fails closed on a fork, a deleted repository or a mismatch. A
pull request into `dev` still takes any source.
`required-checks.txt` applies on `test` and `main`;
`required-checks.dev.txt` lists only the checks the integration branch adds,
and may be absent.

`areas.txt`:

```text
<name>|<label description, at most 100 characters>
#   path: <glob>     one or more; the first glob in the file that matches a file owns it
```

Globs: `*` within a path segment, `**` across segments, `{a,b}` either.

`required-checks.txt`: one check-run name per line, exactly as GitHub shows it,
`#` for comments. List only checks that **always** report on a pull request —
a required check that never starts is a merge freeze. Where a workflow is
path-filtered, require its always-running aggregator instead (DELIVERY §10).

## PR governance

The caller:

```yaml
name: PR governance

on:
  pull_request:
    branches: [dev, test, main]
    types: [opened, edited, reopened, synchronize, ready_for_review]

permissions:
  checks: write
  contents: read
  issues: read
  pull-requests: read

concurrency:
  group: pr-governance-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  governance:
    # A full commit SHA of this repository, never a branch: the code that
    # judges a pull request must be a reviewed commit.
    uses: marvinamiranda/.github/.github/workflows/pr-governance.yml@<40-char sha>
    with:
      runs-on: '["self-hosted", "pool-linux"]'   # runners are self-hosted
      governance-ref: <the same sha>
```

The source policy is a second caller, on the same pull requests. It publishes
`test-source-policy` or `main-source-policy`; `dev` has no source restriction:

```yaml
name: Source policy
on:
  pull_request:
    branches: [dev, test, main]
permissions:
  checks: write
  contents: read
  pull-requests: read
concurrency:
  group: source-policy-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  policy:
    uses: marvinamiranda/.github/.github/workflows/source-policy.yml@<40-char sha>
    with:
      runs-on: '["self-hosted", "pool-linux"]'
      governance-ref: <the same sha>
```

- **Pin by SHA, twice.** `uses:` and `governance-ref` name the same merged
  commit of this repository. A branch ref would let whoever can push to that
  branch change every repository's checks. Moving the pin is a `tier:senior`
  pull request in the adopting repository.
- **The workflow checks the pin** before it fetches any governance code.
  `governance-ref` must equal `job.workflow_sha`, the commit the caller's
  `uses:` pinned (`github.workflow_sha` would be the caller's own commit), and
  that commit must be on this repository's `test`: the branch is read by name
  (`repos.getBranch`, which a tag named `test` cannot shadow), and GitHub's
  compare of its head with the pin says `identical` or `behind`. Otherwise
  `governance/issue-link` fails, and so does `governance / areas`. The check is
  inline in the workflow, because code fetched at `governance-ref` cannot vouch
  for `governance-ref`.
- **What that catches:** a `governance-ref` that is not the `uses:` pin, and a
  pin to a commit that carries this check but is not on `test`, such as an
  unmerged pull request commit or a fork's.
- **What it cannot catch**, because the check is code at the pinned commit:
  - a pin to a commit without the check, merged or not (any commit from before
    it), which runs no check at all;
  - a pin moved back to an older merged commit, which passes (`behind`) with a
    weaker judge;
  - a pull request that adds its own workflow posting `governance/issue-link`:
    every workflow of the repository runs as the Actions app the rulesets pin
    the check to.

  Review is the control for those, which is why moving the pin, and any change
  to `.github/**` in an adopted repository, is `tier:senior` with an
  adversarial review (DELIVERY §10).
- `concurrency` cancels a superseded run, so an edit followed by a push cannot
  finish out of order and leave the older verdict on the head.
- `edited` is what re-runs the issue-link check when only the body changes.
- No `paths:` filter: both jobs must report on every pull request.
- `runs-on` is required and has no default, because a required check on a
  runner that never starts is a merge freeze.
- Where the repository has an aggregating PR gate that wakes on `workflow_run`,
  add `PR governance` to its `workflow_run.workflows`: that makes the gate fire
  on every pull request, and stops it judging before governance has finished
  with nothing left to wake it.

### `governance/issue-link`

The check reads the pull request at run time (not from the event payload). It
passes when the pull request body **closes** an issue with a closing keyword
(`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`,
`resolved`), optionally followed by a colon, then one of `#123`,
`owner/repo#123` or `https://github.com/owner/repo/issues/123`. Several
`Closes` lines all count, and a duplicate (the same number written with another
keyword, cross-repo form or URL) collapses to one. Text inside HTML comments,
fenced code and inline code does not count. That regex is the fast, offline
layer. For a pull request into the **default branch** the authority is GitHub's
own parsing (GraphQL `closingIssuesReferences`), the same parser that closes
the issue on merge: if GitHub links no issue, the check fails. GitHub parses
the body after the event that starts the run, so an empty first answer is asked
again once, 5 seconds later. A pull request opened before its base became the
default branch keeps the links GitHub parsed then: edit its body and save it,
and GitHub reads it again. A pull request referencing only itself fails.

- **Acceptance items are referenced with `Refs #n`, not closed.** A `Refs`
  line (like `Refs #200`) records that a milestone or product acceptance Task
  is touched by this change and stays open until its criteria are proven on
  `test`; `Refs` never closes an issue, so a body with `Refs` alone does not
  satisfy the check. `Closes` and `Refs` may name different issues in one body.
- **Promotion and release pull requests are exempt**, but only when they come
  from the **same repository**. The promotion from `dev` into `test` and the
  release from `test` into `main` are a record of what lands, not one Task's
  closing line, so they pass without a `Closes` line. A fork can name a branch
  `dev` or `test`, so the exemption also compares GitHub's own base and head
  repository full names with this repository: a fork, a deleted repository
  (`null`) or a mismatch is not exempt and fails without a real closing link.
  The `test-source-policy` / `main-source-policy` check is the control for a
  fork actually entering `test` or `main`.
- **`hotfix/*` pull requests** must close at least one issue **in the same
  repository** whose type is **Bug**, and not a pull request.

The job itself appears as `governance / issue-link`. The **required** context
is the check run it publishes, named exactly `governance/issue-link` and
created by the GitHub Actions app; the rulesets pin it to that app. That check
run carries the verdict, and the job does not fail on it, so a failed job left
by an older run cannot keep a pull request red after a later run passes.

### `issue-link-publish.yml`: `governance/issue-link` from the Checks App

`pr-governance.yml` above posts `governance/issue-link` as the GitHub Actions
app. That copy can be forged by any workflow a pull request adds, and it is
filed in the commit's oldest Actions check suite, which a ruleset stops
counting once that workflow runs again on the commit
([.github#6](https://github.com/marvinamiranda/.github/issues/6)). This
reusable workflow posts the same verdict, with the same judge
(`governance/issue-link.js`), as the Checks App
([.github#7](https://github.com/marvinamiranda/.github/issues/7), Task
[.github#10](https://github.com/marvinamiranda/.github/issues/10)). Until the
rulesets move to the Checks App and `pr-governance.yml` stops posting, the two
run side by side (the shadow period) and the Actions copy is the one required.

A caller calls it from the `workflow_run` job of its PR gate, on the default
branch's copy of that workflow (`workflow_run` always runs the default branch's
file, so a pull request cannot edit the job that receives the key):

```yaml
  issue-link:
    if: github.event.workflow_run.event == 'pull_request'
    permissions: { contents: read, issues: read, pull-requests: read }
    uses: marvinamiranda/.github/.github/workflows/issue-link-publish.yml@<40-char sha>
    with:
      runs-on: '["self-hosted", "gate-ephemeral"]'   # exactly this; see below
      governance-ref: <the same 40-char sha>
```

**`runs-on` must be `["self-hosted", "gate-ephemeral"]`.** This job holds the
Checks App key, and `gate-ephemeral` is the single-use VM pool made for it
(decision E). The workflow cannot check the label it is given, so the caller
is the control: any other pool (`pool-linux` runs pull request code on shared
hosts) would put the key where pull request code has run. A caller passing
anything else is a `tier:senior` finding.

- Inputs: `runs-on` (JSON, required, no default) and `governance-ref`, which
  must equal the commit the caller's `uses:` pins and be a commit of this
  repository's `test`. The pin check is the block in `pr-governance.yml`,
  byte for byte; a bad pin fails the job before a token is minted or any code
  is fetched, and nothing is posted.
- Order: verify the pin; fetch `governance/issue-link.js` at `governance-ref`
  and judge, holding only the read `GITHUB_TOKEN`; mint the Checks App token
  (this repository, `checks: write` only); one inline script POSTs the verdict
  on the pull request's **current** head. The fetched code never sees the key.
- `workflow_run.pull_requests` lists **every** open pull request whose head
  sha or head branch matches the run, in any repository. The workflow judges
  **each one whose base repository is this repository** and posts one check
  per head commit, a success only if every pull request on that commit
  passed. If none belongs to this repository, or the payload does not say
  which repository this is, the job fails and posts nothing. If the judge
  cannot run, a **failure** is posted for the head (the pull request's, or
  else the run's own commit), so a success from before a body edit does not
  stand; if no head commit can be found at all, the job fails and posts nothing.
- A summary is cut at 60,000 characters with a `(truncated)` marker (both here
  and in `pr-governance.yml`): the API refuses one over 65,535, and a crafted
  body could otherwise make the post fail and leave an older success standing.
- Runs for one commit queue (`concurrency` on the job, never cancelling); the
  last to run judges the pull requests as they are then.
- The workflow names the `governance-checks` environment itself
  (`deployment: false`); the caller sets nothing. Because that environment
  admits any job on `test`, the workflow checks out no pull request code, has
  no `run:` step and no `${{ }}` inside a script.
  `governance/tests/issue-link-publish.test.js` pins each of these, and
  `governance/tests/issue-link-publish.mutations.js` shows the suite failing on
  45 deliberately broken copies. No other workflow in this repository may name
  the environment or the key (also tested).
- Only JavaScript actions are used, because the `gate-ephemeral` VM has the
  runner, git, python3, jq and curl and nothing else.

It cannot be exercised on its own pull request: the caller's `workflow_run`
runs the default branch's copy. The live proof is the caller's PR (omni237
[#1276](https://github.com/marvinamiranda/omni237/issues/1276) and omni237-ops
[#304](https://github.com/marvinamiranda/omni237-ops/issues/304) follow-ups).

### `governance / areas`

Runs `governance/areas-check.js` against the pull request's merge commit and
fails when a tracked file has no area, an area owns nothing, or a glob can never
win. Locally:

```bash
node governance/areas-check.js <product checkout> [git-ref]
```

## Identities (DELIVERY §9, Appendix A)

Organisation GitHub Apps, created once by the owner.

**Run it from a fresh clone at a merged SHA, with a clean environment.** The
examples below show the arguments; the command line is always

```bash
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/python3 -I -S governance/identity/create-app.py <name> ...
```

(add `GH_TOKEN=<the day's token>` after `env -i` for `--to-environment`).
`create-app.py` refuses, before it runs any command, a `PATH` with an empty
entry (`":$PATH"`, from an unset variable), a relative entry (such as a
literal `~/...`), or an entry that is this checkout under any spelling (a
letter-case variant, the `/System/Volumes/Data` firmlink), because `gh` and
`security` would then be looked up in the checkout while they hold the owner's
token or the key. It refuses rather than cleans: a dirty `PATH` may already
have chosen the `python3` running it, which is why the interpreter is named by
its absolute path. Every command then runs from `/`.

```bash
python3 -I -S governance/identity/create-app.py mm-agent      # builds, opens and merges PRs into test
python3 -I -S governance/identity/create-app.py mm-reviewer   # posts review/independent
```

Their keys go to `~/.config/mm-agent/<name>/` (0600) and are never printed.
Run `create-app.py` **from a merged commit**, like `bootstrap.sh --apply`, and
by the same rule and script (`governance/identity/provenance.sh`): it refuses
a commit that is not on this repository's `test` as GitHub has it now,
uncommitted changes under `governance/`, and files outside a git checkout,
before any `gh` call or page. Only reviewed code handles an App's private key.

- **Always `python3 -I -S`** (isolated mode, no site). Without `-I` Python
  imports modules from the script's own directory first and honours
  `PYTHONPATH`, so a planted `secrets.py` or `json.py` beside the script would
  run as the owner just before the key is handed over. Without `-S` every
  `.pth` file in site-packages runs at start-up, even under `-I`, and
  Homebrew's site-packages is writable by the owner's account.
  `create-app.py` refuses to run without both, as its very first statement.
  That refusal cannot stop code that loads before the script does (a `.pth`
  file, a `sitecustomize`/`usercustomize`), which is why the flags are part of
  the command, not just checked.
- **`test` is read with an empty environment and a clean git configuration**,
  from `/`: `env -i` keeps only `PATH`, so no `GIT_CONFIG_COUNT`/
  `GIT_CONFIG_PARAMETERS`, no `GIT_DIR`, no proxy (`HTTPS_PROXY`, `ALL_PROXY`)
  and no CA override (`SSL_CERT_FILE`, `SSL_CERT_DIR`, `GIT_SSL_*`) reaches it,
  and no global or system config is read. A `url.<x>.insteadOf` in any of
  them (or in the checkout's own `.git/config`), or a proxy with its own CA,
  could otherwise answer for the canonical URL with an unreviewed commit.
- **Nothing under the checkout's `.git` decides, and nothing there runs.**
  Only two things come from the checkout: `HEAD`'s commit id, read from the
  files git keeps it in (no git process runs in the checkout), and the bytes
  of the files under `governance/`. Anything that can write under `.git` could
  otherwise make git run code there with the owner's token in its environment
  (a `core.fsmonitor` hook, a clean filter), or give a real object id other
  content (a replaced pack or loose object, a replace ref, a graft, a
  commit-graph): git re-hashes an object only when it writes one. Every
  decision is made in an empty bare repository the check creates in a private
  scratch directory and fetches `test` into: whether `HEAD` is an ancestor of
  `test`, and what `HEAD`'s files are.
- **Uncommitted means by content**: every file of `HEAD`'s tree under
  `governance/`, as that fetched repository holds it, must be on disk with
  exactly its bytes (hashed with `--no-filters`), and nothing else may be
  there. So an edit hidden from `git status` with skip-worktree or
  assume-unchanged is refused too, and so is any untracked file, whatever the
  checkout's config says. The manifest is then read from the fetched
  repository at that commit, not from the file, which could change after the
  check, and not from the checkout's objects. `provenance.sh` itself is run
  with `PATH` and `TMPDIR` only, never the owner's token.
- A merged commit that is not `test`'s tip runs, with a warning.
- **The App GitHub creates is checked** before its key is used: owned by
  `marvinamiranda`, named as the manifest names it, with exactly the manifest's
  permissions. Otherwise the key is discarded, nothing is written or loaded,
  and it says to delete that App.
Two more are different: their keys never touch the machine's disk.
**MarvinaMiranda Checks** (`mm-checks`) keeps its key in a GitHub environment
secret ([The Checks App](#the-checks-app-mm-checks)), and **MarvinaMiranda
Runners** (`mm-runners`) in the login Keychain
([The Runners App](#the-runners-app-mm-runners)).

**Install or refresh an identity** from a checkout of a merged commit, by the
script's absolute path:

```bash
eval "$(<checkout>/governance/identity/agent-env.sh mm-agent || echo false)" && gh auth status
eval "$(<checkout>/governance/identity/agent-env.sh mm-reviewer || echo false)" && gh auth status
```

**Then open every tool command with the env file it installed**, joined with
`&&`, never `;`:

```bash
. ~/.config/mm-agent/mm-agent/env && gh pr create …
. ~/.config/mm-agent/mm-reviewer/env && governance/identity/post-review.sh owner/repo <sha> success "Matches the Task; tests seen failing first."
```

Both forms stop the command when they cannot set the identity up. A bare
`eval "$(…/agent-env.sh mm-agent)"` does not: when the script is not there
(the checkout moved or went away, or a relative path run from another
directory), it evaluates nothing, succeeds, and the command runs as the owner.
`|| echo false` turns that into a failing eval. `.` of a missing env file
fails, and so does an env file whose shim is gone. The env file is written
only by an eval from a commit on this repository's `test`, so it only ever
runs merged code; an eval from anywhere else sets up its own shell and leaves
the file alone. Sourcing it starts no process.

**Claude Code and Codex need the env file on every tool command**: both
rebuild each command's shell from a snapshot taken when the session began, and
a snapshot taken from the owner's environment carries it. Claude Code's
re-applies the `PATH` it captured, which puts the real `gh` first. Codex's
re-exports every variable it captured, which on the owner's machine includes
their `gh` login token as `GH_PACKAGES_TOKEN` (from `~/.zshrc`). That is the
residual: a tool command that does not open with the env file runs as its
snapshot has it; an alias named `gh` in the snapshot is expanded when the
command line is parsed, before the env file can remove it (there is none on
the owner's machine; `command gh` sidesteps one); and the snapshot files keep
whatever was exported when they were taken (Codex writes them readable by
every local user). Only the owner can clear those files.

`agent-env.sh` sets up the identity as follows. Its integrity checks and trust
limits are described in [Identity integrity and doctor](#identity-integrity-and-doctor).

- puts the identity's `gh` first on `PATH`: a launcher in
  `~/.config/mm-agent/<name>/shim/<commit>/bin/`, alongside `mm-gh-org`, for
  copies of `gh-shim.sh` and `app-token.sh` in `…/libexec/`: the working
  files' bytes that were read once and checked against a commit, never what
  the checkout's object store says. Which commit a shell runs depends on the
  form:
  - the eval installs what the checkout's HEAD is at that moment and switches
    that shell to it. The shell keeps it when the checkout changes or goes
    away, until it evaluates again;
  - the env file runs the commit it names: the last one an eval from a commit
    on `test` installed on this machine. The checkout can change or go away
    without touching it;
- refuses a checkout whose identity scripts (`agent-env.sh`, `gh-shim.sh`,
  `app-token.sh` and the pure `launcher-render.sh`) differ from its HEAD commit
  (compared by content, so a change hidden from `git status` counts), and
  warns when that commit is not on this repository's `test`, or its scripts
  there are not the ones read. It runs no git in the checkout (so nothing in
  its config runs), and decides "on `test`" in a repository of its own that it
  fetches `test` into, as `provenance.sh` does. The answer is remembered as the
  source blob ids that were checked; anything else is asked again at the next
  eval;
- keeps that `gh` first in zsh, login or interactive, without editing the
  owner's files: `ZDOTDIR` points at startup files that source the owner's
  (`~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.zlogin`, with `ZDOTDIR` set to
  the owner's directory while each runs), then put the shim first again, drop
  any `gh` alias or function, and set the variables below again. The owner's
  `~/.zprofile` runs `brew shellenv`, which otherwise puts the real `gh` first
  in every login zsh;
- gives every `gh` call a token from `app-token.sh`, and fails without running
  `gh` when none can be minted;
- refuses `gh auth` except a plain `gh auth status`, `gh alias` except `list`
  and `delete`, and any flag ahead of the command other than a lone `--help`,
  `-h` or `--version` (`gh --help=false auth token` runs `gh auth token`).
  `gh auth token --user <owner>` reads the owner's keyring login whatever
  `GH_TOKEN` holds, and a raw token copied into a variable is never renewed;
- sets `GH_TOKEN` to a sentinel that is not a token, which the shim replaces on
  every call: a real `gh` reached some other way answers `gh auth token` with
  the sentinel, not the keyring login, and GitHub refuses the sentinel;
- unsets `GITHUB_TOKEN`, sets `GH_PACKAGES_TOKEN` only from the owner's
  packages file (below), and prints no token;
- points `GH_CONFIG_DIR` at an empty directory, so the real `gh` finds no
  stored login;
- gives git a github.com credential helper that mints a token per operation,
  and tells git to quit rather than fall back when it cannot;
- two organisations, marvinamiranda (default) and ThruuAi: the git credential
  helper sets `credential.useHttpPath` and takes the org from the requested
  path (`ThruuAi/...` gets a ThruuAi token, anything else marvinamiranda); the
  token cache is per org (`token.cache`, `token.cache.thruuai`); and
  `mm-gh-org <org> <gh arguments...>` runs the same gh with that org's token
  (for example `mm-gh-org ThruuAi api repos/ThruuAi/sm360wf`). Plain `gh` stays
  marvinamiranda. The App must be installed on the org.
- sets the App's bot as git author and committer.

### Identity integrity and doctor

The installer repairs missing, modified or non-executable launchers and startup
files from its verified source. It records the saved installation's merged
commit, identity profile and real-gh path in `installation.json`, and writes the
canonical launcher hashes atomically to `launcher-pins.json` under the shim.
Every source of the saved environment checks both `gh` and `mm-gh-org` as regular
executable files against those pins before accepting the identity.

These checks protect against accidental or stray modification, a stale shim,
a partial install or an edit to the wrong file. A hostile process running as
the same macOS user can read the user's tokens and private key and rewrite all
user-owned launchers, pins, environment, installation record and doctor code.
Replacing a launcher and its pin together can therefore pass the environment
check. Hostile same-user protection and root-owned pinning are outside this
mechanism's scope; it is a strong default, not a sandbox. The owner's keyring
login also remains accessible to that user, and repository rulesets remain a
separate backstop.

The read-only doctor diagnoses drift against the recorded commit, independently
verified as merged on `marvinamiranda/.github` `test`. It fetches that public
source into disposable scratch, runs only the commit's pure launcher renderer,
and compares both installed launchers and both pins with the canonical result.
It does not execute the saved environment or installed launchers, mint a token,
call gh, rewrite installed files, repair pins, or change checkout refs or caches.
The scratch files are cleaned. It remains a user-owned diagnostic tool and does
not establish independence from a hostile same-user process.

```bash
TMPDIR="$HOME/repo/_work" <checkout>/governance/identity/agent-env.sh doctor mm-agent
# or doctor mm-reviewer
```

Use an existing owned scratch directory and a reviewed merged checkout.
Installations made before the record and renderer existed need a reinstall from
reviewed merged source before this diagnostic can succeed. Missing or malformed
records or pins, missing launchers, canonical source unavailability, an unmerged
recorded commit, and canonical mismatches produce fixed typed reasons and a
nonzero exit. The doctor never guesses legacy bytes, silently migrates state, or
falls back to installation. `agent-env doctor: Ok` is the successful result.

If `agent-env.sh` fails once it is running, it prints an environment with no
identity (the sentinel, `gh` refusing and kept first in zsh the same way, git
told to quit, no commit identity, a failing status) instead of nothing, which
would leave the shell on the owner's login, and it leaves the env file as it
was. A script that cannot run at all prints nothing: that is what
`|| echo false` is for.

Bash login shells are not wrapped: on this machine they keep the shim first
(the owner's bash files do not run `brew shellenv`), but macOS `path_helper`
moves inherited entries behind `/usr/local/bin`, so a `gh` installed there
would come first in `bash -l`.

### Packages

GitHub Packages accepts only a classic personal access token, and no App can
mint one, so agents get their own, made by the owner once:

1. On github.com: Settings, Developer settings, Personal access tokens, Tokens
   (classic), Generate new token (classic). Scope: `read:packages` and nothing
   else. Give it an expiry.
2. Save it where only you can read it:
   ```bash
   ( umask 077 && read -rs t && printf '%s\n' "$t" > ~/.config/mm-agent/packages-token )   # paste it, then Enter
   ```

`agent-env.sh` then exports `GH_PACKAGES_TOKEN` (which `nuget.config` reads)
from that file, for both identities. It refuses the file, leaving the variable
unset and saying why in one line, unless it is a regular file you own, with
no permission for group or others (0600), holding one `ghp_` token and
nothing else. So `gh auth token > ~/.config/mm-agent/packages-token`, which
would hand agents your login, is refused. The printed environment reads the
file (`$(cat …)`); it never contains the token. Restores made with it are the
owner's in GitHub's logs: the token is theirs, limited to reading packages.

`app-token.sh` reuses a token for at most 5 minutes after minting it, so a
revoked or suspended installation's token is served for at most 5 minutes,
then the mint fails with GitHub's reason. Checking the cached token on every
use would add a round trip to every `gh` and `git` call (0.49 s from the
owner's machine), and GitHub does not document that a cheap endpoint reflects
a suspension.

`post-review.sh` creates the `review/independent` check run as the Reviewer
App, and the `dev-integration` and `test-integration` rulesets pin that context
to the Reviewer App's id. What that enforces: the check was posted by the
Reviewer identity. On one
machine, keeping builder and reviewer sessions apart is procedural: both keys
sit under the same user. The known follow-up is to post reviews from a workflow
in a locked repository that holds the reviewer key as a secret.

### The Checks App (`mm-checks`)

"MarvinaMiranda Checks" posts the merge-gating governance checks
(`governance/issue-link`, `All checks accounted for`) from default-branch code
(Epic [.github#7](https://github.com/marvinamiranda/.github/issues/7)). Its
key can make any pull request in an adopted repository mergeable, so every
agent session on the machine being able to read `~/.config/mm-agent/` rules
that directory out. The key lives in one place only: the secret
`CHECKS_APP_PRIVATE_KEY` of each adopted repository's `governance-checks`
environment. That environment allows only jobs on the default branch, `dev`
(bootstrap step g). The jobs that use it run on `[self-hosted,
gate-ephemeral]`, single-use VMs
([decision E](https://github.com/marvinamiranda/.github/issues/8#issuecomment-5853703168)),
but the environment's branch rule is the control whatever the runner is.

Permissions (`governance/identity/mm-checks.manifest.json`): exactly Checks
write, Commit statuses write and Metadata read. No webhook, no events. It has
no token helper and no `agent-env.sh` identity on purpose: nothing on the
machine acts as it.

**Create it** (the owner, from a checkout of a merged commit, after bootstrap
step g has created the environments, and with every agent session closed; the
checklist on [.github#8](https://github.com/marvinamiranda/.github/issues/8)
gives the order):

```bash
read -rs GH_TOKEN && export GH_TOKEN      # the one-day fine-grained token below
python3 -I -S governance/identity/create-app.py mm-checks --to-environment --repo omni237 --repo omni237-ops
unset GH_TOKEN
```

Click **Continue to GitHub**, then **Create GitHub App**. The manifest
conversion returns the key once. `create-app.py` sends it to
`gh secret set CHECKS_APP_PRIVATE_KEY --env governance-checks --repo <repo>`
**on stdin** (never in argv, where any local process could read it; `gh`
encrypts it with the environment's public key before it leaves), and sets the
variable `CHECKS_APP_CLIENT_ID` to the App's client id. It writes no
`private-key.pem` and no temporary file, and prints the key nowhere. It writes
`~/.config/mm-agent/mm-checks/app.json` with the App's id, slug and client id
(no secret). Then install the App from the URL it prints on **only the
selected repositories** you named.

It refuses, exiting non-zero before the page opens and so before any App
exists:

- a checkout that is not merged code (see
  [Identities](#identities-delivery-9-appendix-a));
- `mm-checks` without `--to-environment`, or `--to-environment` with any other
  identity; `--to-environment` with no `--repo`, a repository outside
  `marvinamiranda`, or one named twice;
- a shell carrying an agent identity: `GH_TOKEN`/`GITHUB_TOKEN` holding an
  `agent-env.sh` sentinel or an App installation token (`ghs_`), or
  `GH_CONFIG_DIR` under `~/.config/mm-agent/`. The key goes up with the owner's
  credential only;
- a repository whose `governance-checks` environment is missing, allows
  protected branches or every ref, or has any rule besides the default branch
  as a branch rule. Run the bootstrap's step g first;
- a credential that cannot read the environment's secrets;
- an environment already holding `CHECKS_APP_PRIVATE_KEY`, unless `--replace`:
  that is another App's key, and replacing it breaks the gate until the new
  App is installed.

If loading fails part way (a failed `gh`, an exception, an interrupt), the
key is gone with the process, so that App can never be completed. Whatever
stopped it, it prints the App and every repository whose secret was set, even
one whose variable then failed. Delete the App (its settings, Advanced), delete the secret from those
repositories, fix the cause and run it again.

The token, at github.com/settings/personal-access-tokens: resource owner
`marvinamiranda`, expiring the next day, repository access to each `--repo`
only, and:

| Repository permission | Access | For |
|---|---|---|
| Environments | Read and write | the secret, the variable, the environment's public key |
| Actions | Read | reading the environment and its deployment rules |
| Metadata | Read (always included) | the repository's default branch |

Known limit (accepted on
[.github#8](https://github.com/marvinamiranda/.github/issues/8)): while it
runs, the key is in the memory of `create-app.py` and `gh`, both processes of
the owner's account, which is already the root of trust.

### The Runners App (`mm-runners`)

"MarvinaMiranda Runners" mints just-in-time runner configurations for the
single-use `gate-ephemeral` pool
([miranda-infrastructure#584](https://github.com/marvinamiranda/miranda-infrastructure/issues/584)),
whose VMs run the jobs that hold the Checks App's key. It is a dedicated App,
not the Agent App, which holds far broader rights (`workflows: write` among
them). Only the pool controller uses its key, so it has no token helper and no
`agent-env.sh` identity.

Permissions (`governance/identity/mm-runners.manifest.json`): exactly
organisation Self-hosted runners write (generate a JIT config, list and delete
runners), Actions read and Metadata read. No webhook, no events. **Actions read
is a repository permission**, needed to see queued jobs, which no organisation
runner endpoint exposes. Install the App on **only the selected repositories
omni237 and omni237-ops**, so it reaches nothing else.

**Create it** (the owner, from a checkout of a merged commit, with every agent
session closed; step 4 of the checklist on
[.github#8](https://github.com/marvinamiranda/.github/issues/8)):

```bash
python3 -I -S governance/identity/create-app.py mm-runners --to-keychain marvinamiranda.ephemeral-runner-pool
```

Click **Continue to GitHub**, then **Create GitHub App**. The key goes into the
login Keychain as a generic password, with service
`marvinamiranda.ephemeral-runner-pool` and account = the App's client id. It is
stored **base64-encoded on one line**, which the controller decodes after
`security find-generic-password -s <service> -w`.

**How the key reaches `security` without argv.**
`security add-generic-password -w <key>` would put the key in argv, where any
local process can read it. A bare trailing `-w` prompts on the terminal
instead, so it cannot take the key from a pipe. `create-app.py` therefore runs
`security -i` and writes the whole
`add-generic-password -a <client id> -s <service> -w <base64> login.keychain`
command to its stdin. The key is in no process's arguments, and `security`
does not echo input from a pipe.
- **Line-length limit.** `security -i` reads a line into a 4096-byte buffer
  and runs whatever does not fit as a further command, printing it in an
  "unknown command" error. Measured here: lines of up to 4095 characters ran
  whole, and longer ones were split. A GitHub App's RSA-2048 key is about 2,272 characters
  in base64, so it fits. `create-app.py` refuses to send any line over 4000
  characters.
- **Confirming the store.** It checks `security`'s exit status, then that the
  item is there, with a `find-generic-password` that reads no secret (no
  `-w`, no `-g`).
- **What is written.** No `private-key.pem` and no temporary file, and the
  key is printed nowhere. `~/.config/mm-agent/mm-runners/app.json` holds
  `{ app_id, client_id, slug, keychain_service }` and no secret.

It refuses, before the page opens and so before any App exists:
- `mm-runners` without `--to-keychain`;
- `--to-keychain` with any other identity;
- a service name that is not letters, digits, `.`, `_` and `-`, because it
  travels inside the `security -i` line;
- a checkout that is not merged code, or a run without `-I -S` (see
  [Identities](#identities-delivery-9-appendix-a));
- an item already in the login Keychain for that service, unless `--replace`.
  With `--replace`, the existing items are deleted **only after** the new key
  is in hand and the App has been checked, so the controller never finds an
  older App's key first.

The App GitHub creates is checked before its key is stored: owned by
`marvinamiranda`, named "MarvinaMiranda Runners", with exactly the manifest's
permissions. If storing fails for any reason, it prints which App to delete.

Known limit (accepted on
[.github#17](https://github.com/marvinamiranda/.github/issues/17) and
[.github#8](https://github.com/marvinamiranda/.github/issues/8)): any process in
the owner's macOS account can read this Keychain item. That account is already
the root of trust (miranda-infrastructure#549). The mitigation is on #584,
which deletes any runner it did not create.

## Bootstrap

Run it **from a fresh clone at a merged SHA, with a clean environment**:

```bash
env -i HOME="$HOME" GH_TOKEN=<the day's token> PATH=/opt/homebrew/bin:/usr/bin:/bin /bin/bash governance/bootstrap.sh ...
```

The examples below show only the arguments. `bootstrap.sh` refuses, before
it runs any command, a `PATH` with an empty or relative entry, or an entry
that is this checkout under any spelling, since `gh`, `jq` or `mktemp` would
then be looked up in the checkout while it holds the owner's token. It refuses
rather than cleans, because a dirty `PATH` may already have chosen the `bash`
running it. Every command then runs from `/`.

Check this repository out by the SHA of a commit on its `test`. `--apply`
refuses anything else. It refuses a commit
that is not on `test` as GitHub has it now, read from
`https://github.com/marvinamiranda/.github.git` and never from `origin`. It
also refuses a checkout with uncommitted changes, and files outside a git
checkout. It prints the commit it runs from. A dry run from anywhere else
warns and carries on. The rule is `governance/identity/provenance.sh`, which
`create-app.py` applies too, always rather than only for `--apply`.

**First, straight after this repository's own pull request merges**, before
any product repository moves its pin to that commit: this repository's own
rulesets, on their own. Until then it has none, so "on `test`" means only
"pushed", both for the workflow's pin check and for `--apply`'s provenance.

```bash
git checkout <the merged sha>
governance/bootstrap.sh --self-only                   # dry run
governance/bootstrap.sh --self-only --probe --apply   # the probe, then this repository's rulesets
```

`--self-only` takes no `--repo` and touches nothing else: no issue types, no
default branch, no labels. It is also the first run anywhere to create
`main-owner-only`, whose user bypass has never been applied: if GitHub refuses
it, it does so here, after `test-integration` exists, and a re-run is
idempotent.

**Then, for each product repository, after its adoption pull request has
merged into its `dev`.** Every step reads that repository's
`.github/governance/` from `dev`, so none of them can run before the merge (a
dry run can read an unmerged adoption with `--config-dir`). In this order:

```bash
governance/bootstrap.sh --repo <repo> ...                                  # 1. dry run: reads only
governance/bootstrap.sh --repo <repo> ... --no-rulesets --apply            # 2. default branch, labels
governance/bootstrap.sh --repo <repo> ... --probe --no-rulesets --apply    # 3. the Reviewer App probe
# 4. one Agent App merge into dev (proven: see below)
governance/bootstrap.sh --repo <repo> ... --apply                          # 5. rulesets, owner only
governance/bootstrap.sh --repo <repo> ... --project --project-title "<t>"  # also the Project
```

- **Step 2** moves the default branch to `dev`, the integration default. It
  requires `dev` to exist first: a repository without it is left as it is, with
  a warning, so a cutover is deliberate.
- **Step 3**, `--probe`, has the Reviewer App post a neutral
  `review/independent` on each `test` head, so a missing installation shows up
  now rather than on the first blocked pull request. Pass `--no-rulesets` with
  it: without it, the same run goes on to apply the rulesets, before step 4.
- **Step 4**: after step 5 a pull request that passes its checks is the only
  way into `dev`, and agents' pull requests are merged by the Agent App, so its
  merge must work first. It was proven for `test` before the dev cutover:
  [omni237-ops#160](https://github.com/marvinamiranda/omni237-ops/pull/160) was
  squash-merged into `test` by `app/marvinamiranda-agent` (commit `2be0641`,
  2026-09-25 17:52 UTC).
- **The `governance-checks` environment** (step g) is part of every run
  with a `--repo`, `--no-rulesets` included, so step 2 creates it and every
  later run checks it. It holds the Checks App's key
  ([The Checks App](#the-checks-app-mm-checks)), so which refs may use it is
  the control: custom deployment branches (`protected_branches: false`,
  `custom_branch_policies: true`) with exactly one rule, the branch `dev`.
  Any other rule (`refs/pull/*`, `*`, a tag) and any other policy (protected
  branches, or none, which admits every ref) is drift: a dry run reports it,
  `--apply` removes it, rules first, then adds `dev`, so a failure part way
  leaves fewer refs allowed, not more. A repository with no `dev` branch gets
  no environment, with a warning. For an environment adopted before the Checks
  App exists:
  ```bash
  governance/bootstrap.sh --repo omni237 --repo omni237-ops --no-rulesets            # dry run
  governance/bootstrap.sh --repo omni237 --repo omni237-ops --no-rulesets --apply
  ```
- **Step 5** needs the Reviewer App's id (`--reviewer-app-id`, or
  `~/.config/mm-agent/mm-reviewer/app.json`). Without it the run stops before
  changing anything. This repository's own `test-integration` would otherwise
  require only `governance tests`, which a pull request here can rewrite.

Product ruleset runs also need `--checks-app-id <positive integer>`, falling back
to `id` in `~/.config/mm-agent/mm-checks/app.json` (`MM_CHECKS_APP_JSON` overrides
that path). The id must match `GET /apps/marvinamiranda-checks`, differ from the
Reviewer and Actions ids, and have no leading zero. Preflight prints the verified
id. Missing or invalid identity refuses before any write. `--no-rulesets` and
`--self-only` require no Checks App id; `--self-only` output is unchanged.

Only product `test-integration` and `main-checks` pin `governance/issue-link`
and `All checks accounted for` to that App. Reviewer and other Actions issuers,
including dev rulesets, are unchanged. Before any mutation, the bootstrap probes
all requested repos: both exact names must have concluded success from the verified App
on the **same** one of the 20 most recently updated PR heads into test. Check runs
are paginated. Missing/unreadable proof refuses `--apply`; a dry run warns.
A shadow aggregate or an Actions-issued copy cannot qualify.

**Per-repo rollout prerequisite:** product T5 must first merge on dev with
`CHECKS_APP_COPY_REQUIRED = True` and the trusted issue-link publisher enabled.
Promote the trusted publisher onto the repository’s actual default branch before
expecting `workflow_run` evidence, with its environment branch policy matching.
For ops the currently observed default and environment policy are `test`; a
dev merge alone does not execute the candidate publisher. Promotion and policy
changes remain owner-only. Track this in [ops#536](https://github.com/marvinamiranda/omni237-ops/issues/536)
and [omni237#2256](https://github.com/marvinamiranda/omni237/issues/2256).
Observe both required names from App 5105172 on a live PR head into test:

```bash
gh api --paginate "repos/marvinamiranda/omni237-ops/commits/<PR_HEAD_SHA>/check-runs?per_page=100" --jq '.check_runs[] | select(.app.id == 5105172) | [.head_sha, .name, .app.id] | @tsv'
```

Repeat with `omni237` for its own prerequisite. Pinning before publishers exist
freezes test/main merges, including hotfixes. T5 goes first while Actions remains
pinned; once both Apps post required names a failing copy from either can block
the merge, so schedule the owner cutover close to T5. Pilot ops only, then after
one observed pilot merge apply to omni237, after its own proof. For each repo,
also observe **one PR into main posting both names successfully from 5105172**
before declaring main-checks cutover proven. Retain the PR number, head SHA,
updated_at and check-run App ids in the owner rollout record; the bootstrap
prints the test-target PR evidence it proved on. Agents must not
apply rulesets. **sm360 and sm360-sdk are excluded**: their `required ready` gate
and missing Checks App publishers are tracked separately in
[.github#41](https://github.com/marvinamiranda/.github/issues/41).

**Literal rollback / pool recovery:** in a clean owner checkout (not a dirty
worker checkout), restore Actions pins from the pre-change commit. The older
script does not accept `--checks-app-id`; omit it. With the day token already
exported as `GH_TOKEN`, for the pilot:

```bash
git checkout 6057728
env -i HOME="$HOME" GH_TOKEN="$GH_TOKEN" PATH=/opt/homebrew/bin:/usr/bin:/bin /bin/bash governance/bootstrap.sh --repo omni237-ops --reviewer-app-id 5075711
env -i HOME="$HOME" GH_TOKEN="$GH_TOKEN" PATH=/opt/homebrew/bin:/usr/bin:/bin /bin/bash governance/bootstrap.sh --repo omni237-ops --reviewer-app-id 5075711 --apply
```

If both repos were migrated, add `--repo omni237` to both bootstrap commands.
Rollback restores Actions pins over each repo's **current** dev configuration,
not a historical snapshot. The gate-ephemeral pool has no hosted fallback; use
this owner rollback for a prolonged outage, without bypassing required checks.

**The credential for `--apply`** is a fine-grained personal access token of
the owner's that expires the next day, passed as `GH_TOKEN` for that run only.
Never add `admin:org` to the `gh` keyring login: agents on this machine can
reach it, `admin:org` can disable the rulesets, and a scope removed again with
`gh auth refresh --remove-scopes` stays on the token already issued
([cli/cli#9233](https://github.com/cli/cli/issues/9233)). The token, at
github.com/settings/personal-access-tokens:

| Setting | Value | For |
|---|---|---|
| Resource owner | `marvinamiranda` | |
| Expiration | Custom: the next day | |
| Repository access | `.github` and each `--repo` (or all) | |
| Organization: Issue Types | Read and write | a) Epic, Decision, Spike |
| Organization: Projects | Read and write | f) only with `--project` |
| Repository: Actions | Read | g) the `governance-checks` environment and its rules |
| Repository: Administration | Read and write | b) the default branch; e) rulesets; g) the environment |
| Repository: Contents | Read | each repository's `.github/governance/` and `test` |
| Repository: Issues | Read and write | c) labels |
| Repository: Metadata | Read (always included) | repositories, ruleset lists |

The probe, d), needs none of these: it posts with the Reviewer App's own
token. `--self-only` needs Administration and Metadata on `.github` alone. The
organisation may have to approve the token first. Pass it without leaving it
in the shell history:

```bash
read -rs GH_TOKEN && export GH_TOKEN      # paste it; nothing is echoed
governance/bootstrap.sh ... --apply
unset GH_TOKEN
```

GitHub reports no permissions for a fine-grained token, so the bootstrap
checks none in advance: it says which credential it runs with, and a step that
lacks a permission fails, with nothing after it run. `--apply` on the keyring
login warns. `--help` prints the same list.

Reads each repository's `.github/governance/` from `dev` (`--config-dir
<dir>/<repo>/` overrides it for local testing). Dry run by default; idempotent;
never deletes, except g)'s drift: a deployment rule that would release the
Checks App's key to another ref. Labels and Project fields outside the standard are reported for
the owner to retire; legacy rulesets on `dev`, `test` or `main` are set to
enforcement `disabled`, never deleted. `--help` lists the options. Payloads are
kept, and their path printed, when a run fails.

The rulesets go on this repository, first, **and on each `--repo`**. This
repository integrates on `test` (it has no `dev`) and runs no PR governance on
itself, so its `test` and `main` require a pull request, `governance tests`, and
(on `test`) `review/independent`, with no bypass. A product repository gets the
four rulesets below.

- **`dev-integration`**: on `dev`, the integration default. Pull request, no
  approvals. The optional `required-checks.dev.txt` + `governance/issue-link`,
  all pinned to the Actions app, plus `review/independent` pinned to the
  Reviewer App. Any branch may open a pull request into `dev`. Merge commits
  only, no force push, no deletion, no bypass.
- **`test-integration`**: on `test`. Pull request, no approvals. The repo's
  required checks + `governance/issue-link` + `test-source-policy`; the two
  Checks App contexts use its id, the remaining checks use Actions, plus `review/independent` pinned to the Reviewer App. The
  source must be `dev`, `main` or `hotfix/*` (the `test-source-policy` check);
  merge commits only, so `test` and `main` keep one history. No force push, no
  deletion, no bypass.
- **`main-owner-only`**: restrict updates, with one user (the owner's account,
  by id) as the only bypass, in pull-request mode, and nothing else, because a
  bypass actor bypasses every rule of its ruleset. A user, not the
  organisation-admin role, which would extend to every admin.
- **`main-checks`**: on `main`. Pull request (merge commits only, no
  approvals); required checks from both lists + `governance/issue-link` +
  `main-source-policy`; the two Checks App contexts use its id and the rest
  use Actions. The source must be `test` or `hotfix/*`; no force
  push, no deletion; no bypass, so the owner's merges pass the checks too.

`require_extra_approval_for_unattributed_changes` is set to `false` explicitly,
and compared. Merge methods compare as a set, and a rule without any counts as
GitHub's default, all three.

## Tests

```bash
for t in governance/tests/*.test.js; do node "$t" || echo "FAILED: $t"; done   # one file per node
BOOTSTRAP_BASH=/bin/bash node governance/tests/bootstrap.test.js              # macOS bash 3.2
IDENTITY_BASH=/bin/bash node governance/tests/identity.test.js
node governance/tests/issue-link.mutations.js                                 # identity mutants, issue-link
node governance/tests/source-policy.mutations.js                              # identity mutants, source-policy
shellcheck governance/bootstrap.sh governance/identity/*.sh
actionlint                                                                    # reads .github/actionlint.yaml
```

`node governance/tests/*.test.js` runs only the first file: node takes the
rest as its arguments. The bootstrap and identity tests run the scripts
against stubs of `gh` and `curl`, so they need no network and touch no login.
The identity suite also starts zsh as a login and an interactive shell, under
a fake HOME whose startup files put another `gh` first; without zsh those
cases are skipped, and `IDENTITY_REQUIRE_ZSH=1` (set in CI) fails them
instead. `issue-link.mutations.js` and `source-policy.mutations.js` write
deliberately weakened copies of their module (each a single, exactly-once
string replacement) and run the suite against each one with
`ISSUE_LINK_MODULE` / `SOURCE_POLICY_MODULE`: every identity mutant must turn
the suite red, or the runner fails.

### Cross-repository issue-link publisher contract (#33)

The trusted reusable `issue-link-publish.yml` declares only optional
`workflow_call.secrets.CHECKS_APP_PRIVATE_KEY`. Each product caller forwards
that **one named secret**, never `secrets: inherit`; the called job's
`governance-checks` environment value takes precedence. Its existing default
branch restriction, ephemeral runner, verified merged governance pin,
read-only matcher step and later checks-only App token remain required.
After the read-only matcher has finished, a trusted inline presence check
fails the job loudly if the named key is empty or whitespace; minting and
posting require its affirmative output. It never prints the key.
Both the Actions PR-governance caller and Checks App publisher must pin the
same reviewed, merged central commit to use the same matcher.

Accepted supervisor contract: matcher exceptions fail closed in both callers.
The Checks App catches the exception and posts failure, naming its bounded
exception category and HTTP status in the summary; the Actions judge throws
and its job goes red, without a new API check. A check run belongs to a commit:
when multiple PRs share that head, the App fails if **any** PR is unlinked.
This stricter aggregation is intentional. A disagreement blocks a merge;
it cannot authorize a false pass. Tests cover exception handling in both
callers and both orders of a shared head with one unlinked PR.

After this central fix is independently reviewed and merged to `.github/test`,
product T5 callers pin that merged commit and enable their required-name posts.
Product drafts target dev; Claude schedules their batched dev→test promotion
(at most once per day). A real PR head into the repository's default/test
branch must then show App5105172 posting both required names successfully.
Only after that observed proof may the owner cut over rulesets. No synthetic
check posts, key extraction, environment-policy change, or agent merge is
part of this central fix.

### Missing-association recovery and key placement (#43)

The central issue-link publisher recovers a missing workflow_run PR association
through GitHub's paginated open-PR list filtered by `head=owner:branch`.
The commit-associated endpoint is unsuitable for a default-branch release head: it
can report the merged introducer rather than the open release PR. It requires one open
candidate with the exact run SHA, branch and same-repository identity; forks,
ambiguous candidates, malformed eligible data and unreadable APIs fail closed.
When the run SHA is valid, those failures publish a failure verdict on that SHA
so an earlier success cannot stand; invalid/missing SHAs remain unpostable.
Closed or other-SHA candidates are skipped before deep validation. A fresh
identity check before and after judging prevents publishing success after a
force-push or association change. A same-repo test→main release head is valid.
See GitHub's [open pull-request head filter](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests).
Existing listed multi-PR commit aggregation remains stricter: any failure fails
the shared head. Product callers consume this behavior only after this PR merges
and a separately reviewed caller repin; their existing T5 PRs remain untouched.

Bootstrap step g now reads repository and organization secret **name metadata**
with pagination. A broader-scoped `CHECKS_APP_PRIVATE_KEY` is DRIFT requiring
owner remediation; it is never deleted, copied, decrypted or changed by this
check. Permission, network, malformed and incomplete responses are UNVERIFIED,
never proof of absence. Step g cannot report up to date until both scopes were
verified and the key is absent there. `--self-only` makes no such requests and
retains its byte-identical output.

The owner's day-expiring fine-grained token needs **Secrets: read** at repository
and organization scopes for these metadata reads. Never expand the agent login's
keyring privileges. See GitHub's [repository secret metadata endpoint](https://docs.github.com/en/rest/actions/secrets#list-repository-secrets)
and [organization secret metadata endpoint](https://docs.github.com/en/rest/actions/secrets#list-organization-secrets).
After a warning, the owner verifies key custody before any manual remediation;
no secret or environment-policy mutation is authorized by this drift report.

The API-error regression also asserts that arbitrary `error.message` text (the
fixture's `boom`) cannot leak into the App check summary. Bounded exception
category and status remain visible.
