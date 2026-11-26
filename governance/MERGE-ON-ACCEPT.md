# Merge on accept (`/merge <sha>`)

ThruuAi/.github#22. This replaces the Mac-only `~/repo/_handover/merge-pr.sh`, so a lead running in the
cloud can merge a reviewed pull request without the App private keys leaving GitHub. The workflow is
`.github/workflows/merge-on-accept.yml` and the judge is `governance/merge-on-accept.js`. The
contract is in the workflow's header and pinned by `governance/tests/merge-on-accept.test.js`, with
its mutation proof.

## Use
1. The independent reviewer comments on the PR, starting a line with
   `REVIEW ACCEPT <40-char head sha>` (or `REVIEW CHANGES <sha>`), followed by its summary.
2. The repo lead comments `/merge <the same sha>`.
3. The PR gets one comment back: `Merged as <sha> (<method>) …`, or `FAIL <reason> …` with the run link.

## Same as merge-pr.sh
- The head must be the reviewed sha, or a commit with an identical tree.
- `review/independent` is posted as the Reviewer App, and the merge is made as the Agent App with `sha=<head>`.
- Every required check of the base's rulesets must be success, with its App pin. No other check may be running or red, and no commit status may be red. The Checks App shadow rule (#1671) applies.
- The PR is re-checked right before the merge, and "Base branch was modified" is retried.
- Promotions into `test` always use a merge commit. A dev PR uses the caller's method: squash by default, merge for thruu-sale, as `thruu-merge-slice.sh` did.
- After a merge into dev, the issues the body closes in that repository are closed and set to "In dev" or "Done" on their Projects (the old `done-in-dev.sh`).

## Different from merge-pr.sh
- **No 4-hour wait.** If checks are still running, it refuses; comment `/merge` again later.
- **No owner bypass for code-owner rules.** That path uses the owner's own login, so it refuses and says so.
- **The ACCEPT is a comment, not a session identity.** All sessions post as the owner's login, so the job cannot tell the builder from the reviewer. It requires the ACCEPT to:
  - be posted before the command;
  - be unedited;
  - come from someone with write access;
  - not be followed by `REVIEW CHANGES` for the same sha.
- **A superseded check suite is not fixed automatically** (the 2240 lesson). It is refused with the fix: push an empty commit, then `/merge` the same reviewed sha.
- **The runner is checked by name before any key is read** when the caller sets `runner-name-pattern` (thruu-sale: single-use `eph-ci-*` slots).
- **A writer's `REVIEW CHANGES` posted during a "Base branch was modified" retry (up to about 80 s) is not re-read.** The PR state, head and base are.
- **The ci-full mode of the stale-gate rule is not ported.** A ci-full PR is refused while the rule is on.
- **`review/independent` can stay posted after a refusal.** It is posted before the final recheck. If the recheck then refuses (a `hold` label or a new `REVIEW CHANGES` in those seconds), the success check stays on that head. It reflects a real ACCEPT, but a writer could still merge from the UI; a new push clears it.
- **Only writers' verdicts count.** A `REVIEW ACCEPT` or `REVIEW CHANGES` by someone without write access is ignored. A writer's `REVIEW CHANGES` posted while the merge is prepared stops it.
- **A carried head must be an empty commit on the reviewed sha:** one parent, the reviewed sha, with the same tree.

## Adopting a repository (owner steps; secrets and settings are not set by agents)
1. Create the environment `merge-apps` (the caller's `environment` input) in the repository. Deployment branches: the default branch only (`dev` for thruu-sale).
2. Add the environment secrets `AGENT_APP_PRIVATE_KEY` (marvinamiranda-agent) and `REVIEWER_APP_PRIVATE_KEY` (marvinamiranda-reviewer), and the environment variables `AGENT_APP_ID` = 5075705 and `REVIEWER_APP_ID` = 5075711. The job refuses any other ids.
3. Optional repository variables:
   - `MERGE_STALE_GATE` (on/off);
   - `MERGE_RUNNER_JSON`. thruu-sale's default is its self-hosted light runner (`CI_LIGHT_RUNNER_JSON`), following the self-hosted-first rule. `["ubuntu-24.04"]` puts the keys only on a single-use hosted VM, at about a minute of hosted time per merge.
4. The caller's top-level `permissions` grant `contents: read`, `issues: read`, `pull-requests: write`, `checks: read` and `statuses: read`. Only the separate `report` job uses `pull-requests: write`: it posts the `Merged`/`FAIL` comment from the merge job's outputs. A pull request comment needs `pull-requests: write`; `issues: write` alone gets a 403, which the first live run (thruu-sale run 45777638566) showed.
5. Merge the caller `.github/workflows/merge-on-accept.yml` into the default branch, pinned twice (`uses:` and `governance-ref`) to a merged commit of this repository's `test`.

## Open question for the owner: the #849 stale-gate rule on dev
The rule refuses a merge unless the newest green `gate` check tested the merge ref built on the current dev head. It is ported here behind the caller's `stale-gate` input. thruu-sale reads it from the repository variable `MERGE_STALE_GATE`, so switching it needs no code change.

The caller's default is **off**. That matches the live Mac policy (`state/gate-base-policy.tsv`: `ThruuAi/thruu-sale off`, owner decision 2026-11-06, batch mode). Under the 2026-11-24 flow, dev runs no CI, so no `gate` check exists on a dev PR. With the rule **on**, every dev merge would be refused.

| Option | Pros | Cons |
|---|---|---|
| Off for dev (default) | Matches the live policy and the no-CI dev flow. The nightly catches pairs that go red together. | Two green PRs can still be red together on dev until the nightly. |
| On for dev | Catches #812/#830-style pairs before merge. | Needs a `gate` check on every dev PR again (CI on dev), and a re-run after every dev move. |

Recommendation: keep it **off** for dev, and on only where a repo still gates dev PRs. It is the variable, so the owner only confirms the default.
