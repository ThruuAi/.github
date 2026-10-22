#!/usr/bin/env node
'use strict';

// Mutation proof for issue-link-publish.test.js: each mutant is a deliberately
// broken copy of the workflow, and the suite must go red on it. A mutant that
// leaves the suite green means the suite cannot see that mistake.
//
//   node governance/tests/issue-link-publish.mutations.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'issue-link-publish.yml'), 'utf8');
const TEST = path.join(__dirname, 'issue-link-publish.test.js');
const MINT_KEY = "          private-key: ${{ secrets.CHECKS_APP_PRIVATE_KEY }}\n";

// [name, [from, to]] -- `from` must occur exactly once in the workflow.
const mutants = [
  ['repositories: removed from the mint (a token for every repository)', ["          repositories: ${{ github.event.repository.name }}\n", '']],
  ['permission-checks removed from the mint (every permission the App has)', ["          permission-checks: write\n", '']],
  ['a second permission requested by the mint', ["          permission-checks: write\n", "          permission-checks: write\n          permission-contents: write\n"]],
  ['the event guard removed (any event mints a token)', ["    if: github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request'\n", '']],
  ['the event guard widened to every workflow_run', ["github.event.workflow_run.event == 'pull_request'", "github.event.workflow_run.event != ''"]],
  ['posting through github.rest.checks.create', ["await github.request('POST /repos/{owner}/{repo}/check-runs', {", "await github.rest.checks.create({"]],
  ['posting with the GITHUB_TOKEN (the post step loses the minted token)', ["          github-token: ${{ steps.checks-app.outputs.token }}\n", '']],
  ['posting with the GITHUB_TOKEN named explicitly', ["          github-token: ${{ steps.checks-app.outputs.token }}\n", "          github-token: ${{ github.token }}\n"]],
  ['a runs-on default of ubuntu-latest', ["        type: string\n        required: true\n      governance-ref:", "        type: string\n        required: true\n        default: '\"ubuntu-latest\"'\n      governance-ref:"]],
  ['a hosted label in the job', ["runs-on: ${{ fromJSON(inputs.runs-on) }}", "runs-on: ubuntu-latest"]],
  ['checks: write granted to the job', ["      contents: read\n      issues: read\n      pull-requests: read\n    steps:", "      checks: write\n      contents: read\n      issues: read\n      pull-requests: read\n    steps:"]],
  ['the environment removed (the key is not released)', ["    environment:\n      name: governance-checks\n", "    environment:\n      name: other\n"]],
  ['deployment: false removed', ["      deployment: false\n", '']],
  ['the pull request head checked out', ["          repository: ThruuAi/.github\n          ref: ${{ inputs.governance-ref }}\n", "          ref: ${{ github.event.workflow_run.head_sha }}\n"]],
  ['the caller repository checked out beside the matcher', ["      # Holds only the read GITHUB_TOKEN.", "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n        with:\n          persist-credentials: false\n\n      # Holds only the read GITHUB_TOKEN."]],
  ['a run: step added', ["      - name: Fetch the shared matcher\n", "      - name: Echo the title\n        run: echo \"${{ github.event.workflow_run.head_commit.message }}\"\n\n      - name: Fetch the shared matcher\n"]],
  ['an expression inside a script', ["const CAP = 60000;", "const CAP = ${{ github.event.workflow_run.id }};"]],
  ['an action pinned to a tag', ["actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0", "actions/create-github-app-token@v3"]],
  ['the pin check dropped from the judge order (fetch runs without the pin)', ["        if: steps.pin.outputs.ok == 'true'\n        uses: actions/checkout", "        uses: actions/checkout"]],
  ['the mint runs without a verdict', ["        if: steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true' && steps.key.outputs.ready == 'true'\n        uses: actions/create-github-app-token", "        if: steps.pin.outputs.ok == 'true' && steps.key.outputs.ready == 'true'\n        uses: actions/create-github-app-token"]],
  ['the key handed to the judge step', ["        if: steps.pin.outputs.ok == 'true'\n        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\n        with:\n          script: |\n            const fs = require('fs');\n            const path = require('path');\n            const lib", "        if: steps.pin.outputs.ok == 'true'\n        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\n        with:\n          github-token: ${{ secrets.CHECKS_APP_PRIVATE_KEY }}\n          script: |\n            const fs = require('fs');\n            const path = require('path');\n            const lib"]],
  ['the verify-pin block drifts from pr-governance.yml', ["if (ref !== self) {", "if (ref === '') {"]],
  ['a failed pin posts a check instead of failing the job', ["              core.setFailed(problem);\n", "              await github.request('POST /repos/{owner}/{repo}/check-runs', { name: 'governance/issue-link', head_sha: 'x', conclusion: 'success' });\n"]],
  ['a judge error is swallowed (no failure verdict)', ["                  ok: false,\n                  title: 'The issue-link judge could not run',", "                  ok: true,\n                  title: 'The issue-link judge could not run',"]],
  ['a non-boolean ok counts as success', ["conclusion: verdict.ok === true ? 'success' : 'failure'", "conclusion: verdict.ok ? 'success' : 'failure'"]],
  ['the head sha is not validated before posting', ["                || !verdicts.every((v) => v && /^[0-9a-f]{40}$/.test(v.headSha || ''))) {", "                || false) {"]],
  ['the head comes from the event, not the verdict', ["head_sha: verdict.headSha,", "head_sha: context.payload.workflow_run.head_sha,"]],
  ['a second job added', ["\njobs:\n  publish:", "\njobs:\n  extra:\n    runs-on: ${{ fromJSON(inputs.runs-on) }}\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\n  publish:"]],
  // Review of c65c5c89 (F1-F6).
  ['F1: only the LAST listed pull request is judged (listed[length-1])', ["for (const listedPull of mine) {", "for (const listedPull of mine.slice(-1)) {"]],
  ['F1: only the FIRST listed pull request is judged (listed[0])', ["for (const listedPull of mine) {", "for (const listedPull of mine.slice(0, 1)) {"]],
  ['F1: the base-repository filter dropped (another repository\'s pull requests judged)', ["              && here !== undefined && p.base && p.base.repo && p.base.repo.id === here);", "              );"]],
  ['F1: a payload with no repository id is trusted', ["              && here !== undefined && p.base", "              && p.base"]],
  ['F1: a commit passes if the first of its pull requests does', ["const ok = failing.length === 0;", "const ok = group[0].ok === true;"]],
  ['F1: one verdict for the run\'s head, ignoring which commit each pull request has', ["const heads = new Map();\n            for (const j of judged) heads.set(j.headSha, [...(heads.get(j.headSha) || []), j]);", "const heads = new Map();\n            for (const j of judged) heads.set(HEAD_OF_RUN, [...(heads.get(HEAD_OF_RUN) || []), j]);\n            const HEAD_OF_RUN = runHead;"]],
  ['F2: the pin check is never called (const problem = \'\')', ["const problem = await verifyPin({ github, env: process.env });", "const problem = '';"]],
  ['F2: a failed pin does not set ok=false', ["core.setOutput('ok', problem ? 'false' : 'true');", "core.setOutput('ok', 'true');"]],
  ['F3: the judge does not truncate the summary', ["return s.length <= CAP ? s : `${s.slice(0, CAP - 40)}\\n\\n(truncated)`;", "return s;"]],
  ['F3: the post does not truncate the summary', ["return s.length <= 60000 ? s : `${s.slice(0, 59960)}\\n\\n(truncated)`;", "return s;"]],
  ['F4: the concurrency block removed', ["    concurrency:\n      group: issue-link-publish-${{ github.event.workflow_run.head_sha }}\n      cancel-in-progress: false\n", ""]],
  ['F4: the concurrency group cancels in progress', ["      cancel-in-progress: false\n    environment:", "      cancel-in-progress: true\n    environment:"]],
  ['F4: the concurrency group is not per commit', ["group: issue-link-publish-${{ github.event.workflow_run.head_sha }}", "group: issue-link-publish"]],
  ['F6/R3: always() on the mint step', ["        if: steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true' && steps.key.outputs.ready == 'true'\n        uses: actions/create-github-app-token", "        if: always() && steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true' && steps.key.outputs.ready == 'true'\n        uses: actions/create-github-app-token"]],
  ['F6/R3: always() on the post step', ["        if: steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true' && steps.key.outputs.ready == 'true'\n        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\n        with:\n          github-token:", "        if: always()\n        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\n        with:\n          github-token:"]],
  ['recovery skips the missing-association lookup', ["if (listed.length === 0) {", "if (false) {"]],
  ['recovery treats another commit SHA as an eligible candidate', ["head.sha !== runHead)", "false)"]],
  ['recovery accepts another head branch', ["if (head.ref !== branch) {", "if (false) {"]],
  ['recovery treats a fork head as an eligible candidate', ["head.repo.id !== here)", "false)"]],
  ['recovery treats a foreign base as an eligible candidate', ["base.repo.id !== here)) continue;", "false) continue;"]],
  ['recovery ignores the workflow run repository', ["runRepo !== here) {", "false) {"]],
  ['recovery picks one of two exact open PRs', ["if (open.length !== 1) {", "if (open.length === 0) {"]],
  ['recovery silently skips a malformed candidate', ["await failOnRunHead('An eligible pull request has a malformed head or repository identity.');\n                  return;", "continue;"]],
  ['recovery reads only page one', ["candidates = await github.paginate(github.rest.pulls.list,\n                  { owner, repo, state: 'open', head: `${owner}:${branch}`, per_page: 100 });", "candidates = (await github.rest.pulls.list(\n                  { owner, repo, state: 'open', head: `${owner}:${branch}`, per_page: 100, page: 1 })).data;"]],
  ['recovery masks list API errors as no match', ["await failOnRunHead(`Could not list open pull requests for the run branch (HTTP ${status}).`);", "candidates = [];" ]],
  ['recovery omits the fresh pre-judge PR read', ["if (recovered && !(await recoveredIsCurrent(number))) {", "if (false) {"]],
  ['recovery queries merged commit association instead of open head-list', ["candidates = await github.paginate(github.rest.pulls.list,\n                  { owner, repo, state: 'open', head: `${owner}:${branch}`, per_page: 100 });", "candidates = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit,\n                  { owner, repo, commit_sha: runHead, per_page: 100 });"]],
  ['recovery failure keeps an older App success standing', ["core.setOutput('judged', 'true');\n              await core.summary.addHeading", "core.setOutput('judged', 'false');\n              await core.summary.addHeading"]],
  ['recovery first read ignores a retargeted base', ["current.base.ref !== recovered.base.ref", "false"]],
  ['recovery branch is interpolated into checkout', ["          ref: ${{ inputs.governance-ref }}", "          ref: ${{ github.event.workflow_run.head_branch }}"]],
  ['recovery accepts the matcher verdict on a different head', ["if (verdict.headSha !== runHead || !(await recoveredIsCurrent(number))) {", "if (!(await recoveredIsCurrent(number))) {"]],
  ['recovery omits the fresh post-judge PR read', ["if (verdict.headSha !== runHead || !(await recoveredIsCurrent(number))) {", "if (verdict.headSha !== runHead) {"]],
  ['missing matcher result posts failure but leaves job silently green', ["if (verdicts.some((v) => v.failJobAfterPost === true)) {", "if (false) {"]],
  ['arbitrary exception message leaks into the summary', ["summary: `The judge failed with ${exception} (${status}).", "summary: `The judge failed with ${exception} (${status}): ${error.message}."]],
  ['empty key authorizes mint and post', ["if (!(process.env.CHECKS_PRIVATE_KEY || '').trim()) {", "if (false) {"]],
  ['mint drops the nonempty key guard', ["        if: steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true' && steps.key.outputs.ready == 'true'\n        uses: actions/create-github-app-token", "        if: steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true'\n        uses: actions/create-github-app-token"]],
  ['post drops the nonempty key guard', ["        if: steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true' && steps.key.outputs.ready == 'true'\n        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\n        with:\n          github-token:", "        if: steps.pin.outputs.ok == 'true' && steps.judge.outputs.judged == 'true'\n        uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\n        with:\n          github-token:"]],
  ['F6/R5: timeout-minutes removed', ["    timeout-minutes: 5\n", ""]],
  ['F6/R5: timeout-minutes raised to 360', ["    timeout-minutes: 5\n", "    timeout-minutes: 360\n"]],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilp-mut-'));
const run = (file) => spawnSync('node', [TEST], { encoding: 'utf8', env: { ...process.env, ISSUE_LINK_PUBLISH_WORKFLOW: file } });

const baseline = run(path.join(ROOT, '.github', 'workflows', 'issue-link-publish.yml'));
console.log(`baseline: exit ${baseline.status} (must be 0)`);
let bad = baseline.status !== 0 ? 1 : 0;

for (const [name, [from, to]] of mutants) {
  const count = SOURCE.split(from).length - 1;
  if (count !== 1) { bad += 1; console.log(`BROKEN MUTANT - ${name}: the anchor occurs ${count} times, expected 1`); continue; }
  const file = path.join(dir, 'mutant.yml');
  fs.writeFileSync(file, SOURCE.replace(from, () => to));
  const result = run(file);
  const red = result.status !== 0;
  const first = (result.stdout.split('\n').find((l) => l.startsWith('not ok')) || result.stderr.split('\n')[0] || '').slice(0, 110);
  if (!red) bad += 1;
  console.log(`${red ? 'killed  ' : 'SURVIVED'} - ${name}${red ? `  [${first}]` : ''}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} problem(s)` : `\nall ${mutants.length} mutants killed`);
process.exit(bad ? 1 : 0);
