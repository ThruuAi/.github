#!/usr/bin/env node
'use strict';

// .github/workflows/merge-on-accept.yml and governance/merge-on-accept.js (ThruuAi/.github#22).
//
//   node governance/tests/merge-on-accept.test.js
//
// Static: the shape that keeps the two App keys away from pull request code. Behavioural: the judge,
// the recheck and the workflow's inline scripts run against a fake API, through the cases of #22
// (a) no ACCEPT, (b) ACCEPT for an older sha after a new push, (c) a commenter without write,
// (d) a valid merge into dev, (e) a promotion into test with a merge commit, and every other refusal.
// Needs python3 with PyYAML, as the other workflow suites do.
//
// MERGE_ON_ACCEPT_WORKFLOW / MERGE_ON_ACCEPT_LIB point at other copies, which is how the mutation proof
// (merge-on-accept.mutations.js) shows a broken copy turns this suite red.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOW = process.env.MERGE_ON_ACCEPT_WORKFLOW
  ? path.resolve(process.env.MERGE_ON_ACCEPT_WORKFLOW)
  : path.join(ROOT, '.github', 'workflows', 'merge-on-accept.yml');
const LIB = process.env.MERGE_ON_ACCEPT_LIB
  ? path.resolve(process.env.MERGE_ON_ACCEPT_LIB)
  : path.join(ROOT, 'governance', 'merge-on-accept.js');
const PUBLISH = path.join(ROOT, '.github', 'workflows', 'issue-link-publish.yml');

function load(file) {
  const parsed = spawnSync('python3', ['-c', 'import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', file], { encoding: 'utf8' });
  if (parsed.status !== 0) { console.log(`not ok - ${path.basename(file)} parses: ${parsed.stderr.trim()}`); process.exit(1); }
  return JSON.parse(parsed.stdout);
}

let failed = 0;
let total = 0;
function ok(name, condition, detail = '') {
  total += 1;
  if (condition) console.log(`ok - ${name}`);
  else { failed += 1; console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`); }
}

const doc = load(WORKFLOW);
const publish = load(PUBLISH);
const lib = require(LIB);
const job = (doc.jobs && doc.jobs.merge) || {};
const steps = job.steps || [];
const script = (s) => (s && s.with && typeof s.with.script === 'string' ? s.with.script : '');
const byName = (name) => steps.find((s) => s.name === name) || {};
const indexOf = (name) => steps.findIndex((s) => s.name === name);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// ---------------------------------------------------------------- static ----------------------------------------------
const triggers = Object.keys(doc.on || doc[true] || {});
ok('only workflow_call triggers it (never pull_request_target)', triggers.length === 1 && triggers[0] === 'workflow_call', triggers.join(','));
ok('the job runs only for a new /merge comment on a pull request',
  /github\.event_name == 'issue_comment'/.test(job.if || '') && /github\.event\.action == 'created'/.test(job.if || '')
  && /github\.event\.issue\.pull_request/.test(job.if || '') && /startsWith\(github\.event\.comment\.body, '\/merge'\)/.test(job.if || ''));
ok('the keys come from the caller-named environment, default merge-apps',
  job.environment && job.environment.name === '${{ inputs.environment }}' && ((doc.on || doc[true]).workflow_call.inputs.environment.default === 'merge-apps'));
ok('both tokens are minted from the environment\'s App ids', (byName('Mint the Agent App token').with || {})['app-id'] === '${{ vars.AGENT_APP_ID }}'
  && (byName('Mint the Reviewer App token').with || {})['app-id'] === '${{ vars.REVIEWER_APP_ID }}');
const perms = job.permissions || {};
ok('the GITHUB_TOKEN cannot write code, PRs or checks',
  perms.contents === 'read' && perms['pull-requests'] === 'read' && perms.checks === 'read' && perms.issues === 'write' && !('actions' in perms));
ok('no step has a run: key', steps.every((s) => !('run' in s)));
ok('no ${{ }} expression inside any script', steps.every((s) => !script(s).includes('${{')));
const checkouts = steps.filter((s) => String(s.uses || '').startsWith('actions/checkout@'));
ok('the only checkout is ThruuAi/.github at governance-ref, sparse, without credentials',
  checkouts.length === 1 && checkouts[0].with.repository === 'ThruuAi/.github' && checkouts[0].with.ref === '${{ inputs.governance-ref }}'
  && checkouts[0].with['persist-credentials'] === false && checkouts[0].with['sparse-checkout'] === 'governance/merge-on-accept.js');
const pinBlock = (text) => { const m = /\/\/ BEGIN verify-pin[^\n]*\n([\s\S]*?)\n[ \t]*\/\/ END verify-pin/.exec(text); return m ? m[1] : null; };
const publishPin = pinBlock(script(publish.jobs.publish.steps.find((s) => s.name === 'Verify the pin')));
ok('the first step is the verify-pin check, the same text as issue-link-publish.yml',
  steps[0] && steps[0].name === 'Verify the pin' && publishPin && pinBlock(script(steps[0])) === publishPin);
ok('every later step needs the pin', steps.slice(1).every((s) => /steps\.(pin|judge|key|review|recheck|merge)\.outputs\./.test(String(s.if || '')) || s.name === 'Report on the pull request'));
const usesSecret = (s) => JSON.stringify(s).includes('secrets.');
ok('only the key check and the two mint steps read a secret',
  steps.filter(usesSecret).map((s) => s.name).join('|') === 'Require the App keys|Mint the Reviewer App token|Mint the Agent App token');
const fetched = (s) => script(s).includes('.org-governance');
ok('fetched code never holds an App token or key', steps.filter(fetched).every((s) => !(s.with && s.with['github-token']) && !usesSecret(s)));
ok('the judge runs before any key is read', indexOf('Judge the pull request') < indexOf('Require the App keys')
  && indexOf('Require the App keys') < indexOf('Mint the Reviewer App token'));
ok('the recheck runs after the review is posted and before the Agent token is minted',
  indexOf('Post review/independent') < indexOf('Recheck before the merge') && indexOf('Recheck before the merge') < indexOf('Mint the Agent App token'));
const rev = byName('Mint the Reviewer App token').with || {};
ok('the Reviewer token is this repository only, checks: write only',
  rev.repositories === '${{ github.event.repository.name }}' && rev['permission-checks'] === 'write'
  && Object.keys(rev).filter((k) => k.startsWith('permission-')).length === 1);
const agent = byName('Mint the Agent App token').with || {};
ok('the Agent token is this repository only', agent.repositories === '${{ github.event.repository.name }}' && agent['permission-contents'] === 'write');
ok('the review is posted with the Reviewer token, the merge with the Agent token',
  (byName('Post review/independent').with || {})['github-token'] === '${{ steps.reviewer-app.outputs.token }}'
  && (byName('Merge as the Agent App').with || {})['github-token'] === '${{ steps.agent-app.outputs.token }}');
ok('the report runs on every outcome, last', /^always\(\)/.test(String(byName('Report on the pull request').if || ''))
  && indexOf('Report on the pull request') === steps.length - 1);
ok('every action is pinned to a full sha', steps.every((s) => !s.uses || /@[0-9a-f]{40}$/.test(String(s.uses).split(' ')[0])));

// ---------------------------------------------------------------- fake API --------------------------------------------
const OWNER = 'ThruuAi';
const REPO = 'thruu-sale';
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);
const DEVH = 'd'.repeat(40);
const MERGEREF = 'e'.repeat(40);
const REVIEWER_APP = 5075711;

function httpError(status, message) { return Object.assign(new Error(message || `HTTP ${status}`), { status }); }

function world(over = {}) {
  const w = {
    roles: { lead: 'admin', reviewer: 'write', reader: 'read' },
    pr: { number: 7, state: 'open', draft: false, merged: false, title: 'feat: x', body: 'Closes #3\nCloses ThruuAi/omni237#9',
      base: { ref: 'dev', repo: { id: 1 } }, head: { sha: H1, ref: 'feature/x', repo: { id: 1 } }, labels: [] },
    trees: { [H1]: 't1', [H2]: 't2', [H3]: 't1' },
    parents: { [H3]: [H1], [H2]: [H1] },
    comments: [
      { id: 10, user: { login: 'reviewer' }, body: `REVIEW ACCEPT ${H1}\nLooks right.`, created_at: '2026-11-26T01:00:00Z', updated_at: '2026-11-26T01:00:00Z', html_url: 'u10' },
    ],
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'review/independent', integration_id: REVIEWER_APP }] } }],
    runs: {},
    statuses: {},
    refs: { 'heads/dev': DEVH, 'heads/test': DEVH, 'pull/7/merge': MERGEREF },
    commits: { [MERGEREF]: { parents: [{ sha: DEVH }, { sha: H1 }], committer: { date: '2026-11-26T01:00:00Z' } } },
    suites: {},
    issues: { 3: { state: 'open' } },
    calls: [],
    mergeAnswers: [],
  };
  return Object.assign(w, over);
}

function fakeGithub(w) {
  const rec = (name, args) => { w.calls.push({ name, args }); };
  const rest = {
    repos: {
      getCollaboratorPermissionLevel: async ({ username }) => {
        if (!(username in w.roles)) throw httpError(404);
        return { data: { role_name: w.roles[username], permission: w.roles[username] } };
      },
      getBranchRules: async () => ({ data: w.rules }),
      getCombinedStatusForRef: async ({ ref }) => ({ data: { statuses: w.statuses[ref] || [] } }),
    },
    pulls: {
      get: async () => ({ data: JSON.parse(JSON.stringify(w.pr)) }),
      merge: async (args) => {
        rec('merge', args);
        if (w.onMerge) { const f = w.onMerge; w.onMerge = null; f(); }
        const next = w.mergeAnswers.shift();
        if (next instanceof Error) throw next;
        if (args.sha !== w.pr.head.sha) throw httpError(409, 'Head branch was modified');
        return { data: { merged: true, sha: 'f'.repeat(40) } };
      },
    },
    issues: {
      listComments: async () => ({ data: w.comments }),
      createComment: async (args) => { rec('comment', args); return { data: {} }; },
      get: async ({ issue_number: n }) => { if (!w.issues[n]) throw httpError(404); return { data: w.issues[n] }; },
      update: async (args) => { rec('update', args); return { data: {} }; },
    },
    git: {
      getCommit: async ({ commit_sha: sha }) => {
        if (w.commits[sha]) return { data: w.commits[sha] };
        if (!w.trees[sha]) throw httpError(404);
        return { data: { tree: { sha: w.trees[sha] }, parents: (w.parents[sha] || []).map((p) => ({ sha: p })) } };
      },
      getRef: async ({ ref }) => { if (!w.refs[ref]) throw httpError(404); return { data: { object: { sha: w.refs[ref] } } }; },
    },
    checks: {
      listForRef: async ({ ref }) => ({ data: { check_runs: w.runs[ref] || [] } }),
      create: async (args) => {
        rec('check', args);
        const run = { id: 1000 + w.calls.length, name: args.name, status: 'completed', conclusion: args.conclusion, app: { id: REVIEWER_APP, slug: 'marvinamiranda-reviewer' } };
        w.runs[args.head_sha] = [...(w.runs[args.head_sha] || []), run];
        return { data: { head_sha: args.head_sha, conclusion: args.conclusion } };
      },
      getSuite: async ({ check_suite_id: id }) => ({ data: { created_at: w.suites[id] } }),
    },
  };
  const paginate = async (fn, args) => {
    const { data } = await fn(args);
    return Array.isArray(data) ? data : data.check_runs;
  };
  const graphql = async (q, vars) => { rec('graphql', vars); return q.startsWith('query') ? { repository: { issue: { projectItems: { nodes: [
    { id: 'item', project: { id: 'proj', field: { id: 'fld', options: [{ id: 'o-done', name: 'Done' }, { id: 'o-dev', name: 'In dev' }] } } }] } } } } : {}; };
  return { rest, paginate, graphql };
}

const command = (sha, over = {}) => ({ id: 50, user: { login: 'lead' }, body: `/merge ${sha}`, ...over });
const judge = (w, cmd = command(H1), policy = { devMergeMethod: 'merge', staleGate: 'off' }) =>
  lib.judge({ github: fakeGithub(w), owner: OWNER, repo: REPO, prNumber: 7, comment: cmd, policy });
const refused = (v, re) => v && v.ok === false && re.test(v.reason || '');

// The workflow's inline scripts, run as github-script runs them.
function coreFake() {
  const c = { outputs: {}, failed: null, warnings: [], setOutput(k, v) { c.outputs[k] = v; }, setFailed(m) { c.failed = m; },
    info() {}, warning(m) { c.warnings.push(m); }, summary: { addHeading() { return this; }, addRaw() { return this; }, async write() {} } };
  return c;
}
async function runStep(name, w, temp, env = {}) {
  const core = coreFake();
  const saved = { ...process.env };
  Object.assign(process.env, { RUNNER_TEMP: temp, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: `${OWNER}/${REPO}`, GITHUB_RUN_ID: '1', MERGE_RETRY_MS: '1' }, env);
  const context = { repo: { owner: OWNER, repo: REPO }, payload: { issue: { number: 7 }, comment: env.__comment || command(H1) } };
  const req = (m) => (m === './.org-governance/governance/merge-on-accept.js' ? lib : require(m));
  try {
    await new AsyncFunction('github', 'context', 'core', 'require', script(byName(name)))(fakeGithub(w), context, core, req);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  return core;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'merge-on-accept-'));
const result = (temp) => { try { return JSON.parse(fs.readFileSync(path.join(temp, 'merge-result.json'), 'utf8')); } catch (e) { return null; } };

// The whole job, step by step, with each step's `if` reduced to the output it needs.
async function runJob(w, { cmd = command(H1), env = {}, keys = true } = {}) {
  const temp = tmp();
  const base = { DEV_MERGE_METHOD: 'merge', STALE_GATE: 'off', GATE_CHECK: 'gate', REQUIRED_CHECKS: '', __comment: cmd, ...env };
  const judged = await runStep('Judge the pull request', w, temp, base);
  let merged = null;
  if (judged.outputs.ok === 'true') {
    const ids = { AGENT_APP_ID: '5075705', REVIEWER_APP_ID: '5075711', RUNNER_NAME: 'eph-ci-20261126010101-abcdef', RUNNER_NAME_PATTERN: '^eph-ci-[0-9]{14}-[0-9a-f]{6}$', ...(env.keyEnv || {}) };
    const key = await runStep('Require the App keys', w, temp, keys ? { AGENT_PRIVATE_KEY: 'k', REVIEWER_PRIVATE_KEY: 'k', ...ids } : { AGENT_PRIVATE_KEY: '', REVIEWER_PRIVATE_KEY: '', ...ids });
    if (key.outputs.ready === 'true') {
      const review = await runStep('Post review/independent', w, temp);
      if (review.outputs.posted === 'true') {
        const re = await runStep('Recheck before the merge', w, temp);
        if (re.outputs.ok === 'true') {
          merged = await runStep('Merge as the Agent App', w, temp, { STALE_GATE: base.STALE_GATE });
          if (merged.outputs.merged === 'true') await runStep('Done in dev', w, temp);
        }
      }
    }
  }
  await runStep('Report on the pull request', w, temp);
  const reports = w.calls.filter((c) => c.name === 'comment' && c.args.issue_number === 7).map((c) => c.args.body);
  return { temp, result: result(temp), report: reports[reports.length - 1] || '', merged };
}

(async () => {
  // ------------------------------------------------------------ parsing -----------------------------------------------
  ok('parseCommand reads /merge <sha40> on the first line', lib.parseCommand(`\n  /merge ${H1}  \nthanks`) === H1);
  ok('parseCommand refuses a short sha, extra words or a later line',
    lib.parseCommand('/merge abc') === null && lib.parseCommand(`/merge ${H1} now`) === null && lib.parseCommand(`hi\n/merge ${H1}`) === null);
  ok('parseVerdict reads one verdict line', JSON.stringify(lib.parseVerdict(`ok\nREVIEW ACCEPT ${H1} fine`)) === JSON.stringify({ verdict: 'ACCEPT', sha: H1 }));
  ok('parseVerdict ignores a comment with two verdicts', lib.parseVerdict(`REVIEW ACCEPT ${H1}\nREVIEW CHANGES ${H1}`) === null);

  // ------------------------------------------------------------ #22 cases ---------------------------------------------
  {
    const w = world({ comments: [] });
    const r = await runJob(w);
    ok('(a) /merge with no ACCEPT fails, posts nothing and says FAIL', r.result && r.result.state === 'refused'
      && /No `REVIEW ACCEPT/.test(r.result.reason) && !w.calls.some((c) => c.name === 'check' || c.name === 'merge') && r.report.startsWith('FAIL '));
  }
  {
    const w = world();
    w.pr.head.sha = H2; // a new push with a different tree after the ACCEPT of H1
    const r = await runJob(w);
    ok('(b) ACCEPT for an older sha, then a new push: FAIL head moved', /head moved to bbbbbbbb/.test((r.result || {}).reason || '') && !w.calls.some((c) => c.name === 'merge'));
    const w2 = world(); w2.pr.head.sha = H2;
    ok('(b) /merge <new sha> without an ACCEPT of the new sha fails', refused(await judge(w2, command(H2)), /No `REVIEW ACCEPT b{40}`/));
  }
  {
    const w = world();
    const r = await runJob(w, { cmd: command(H1, { user: { login: 'reader' } }) });
    ok('(c) a commenter without write: FAIL, nothing posted', /reader does not have write access/.test((r.result || {}).reason || '') && !w.calls.some((c) => c.name === 'check'));
    ok('(c) an unknown commenter (no permission record) fails', refused(await judge(world(), command(H1, { user: { login: 'stranger' } })), /does not have write access/));
  }
  {
    const w = world();
    const r = await runJob(w);
    const check = w.calls.find((c) => c.name === 'check');
    const merge = w.calls.find((c) => c.name === 'merge');
    ok('(d) valid: review/independent=success is posted on the head', check && check.args.name === 'review/independent' && check.args.head_sha === H1 && check.args.conclusion === 'success');
    ok('(d) valid: merged by sha with the caller\'s dev method', merge && merge.args.sha === H1 && merge.args.merge_method === 'merge' && merge.args.pull_number === 7);
    ok('(d) valid: the PR says Merged', /^Merged as f{40} \(merge\)/.test(r.report));
    ok('(d) done in dev closes the same-repository issue and sets Project status In dev',
      w.calls.some((c) => c.name === 'update' && c.args.issue_number === 3 && c.args.state === 'closed')
      && w.calls.some((c) => c.name === 'graphql' && c.args.oid === 'o-dev')
      && !w.calls.some((c) => c.name === 'update' && c.args.issue_number === 9));
    const sq = world();
    const v = await judge(sq, command(H1), { devMergeMethod: 'squash', staleGate: 'off' });
    ok('(d) squash is the default dev method', v.ok === true && v.method === 'squash' && (await judge(world(), command(H1), { staleGate: 'off' })).method === 'squash');
  }
  {
    const w = world();
    w.pr.base.ref = 'test';
    w.pr.head.ref = 'dev';
    const r = await runJob(w, { env: { DEV_MERGE_METHOD: 'squash' } });
    const merge = w.calls.find((c) => c.name === 'merge');
    ok('(e) a promotion into test merges with a merge commit, whatever the dev method', merge && merge.args.merge_method === 'merge' && r.result.state === 'merged');
    ok('(e) a promotion closes no issue here (done-in-dev is dev only)', !w.calls.some((c) => c.name === 'update'));
  }

  // ------------------------------------------------------------ other refusals ----------------------------------------
  const cases = [
    ['a bad command', (w) => [w, command(H1, { body: '/merge please' })], /exactly `\/merge <40-character sha>`/],
    ['a draft', (w) => { w.pr.draft = true; return [w]; }, /draft/],
    ['a closed PR', (w) => { w.pr.state = 'closed'; return [w]; }, /is closed/],
    ['the hold label', (w) => { w.pr.labels = [{ name: 'hold' }]; return [w]; }, /'hold' label/],
    ['base main', (w) => { w.pr.base.ref = 'main'; return [w]; }, /main and uat stay with the owner/],
    ['a fork', (w) => { w.pr.head.repo.id = 2; return [w]; }, /fork/],
    ['CHANGES after ACCEPT', (w) => { w.comments.push({ id: 11, user: { login: 'reviewer' }, body: `REVIEW CHANGES ${H1}`, html_url: 'u11' }); return [w]; }, /asks for changes/],
    ['an edited ACCEPT', (w) => { w.comments[0].updated_at = '2026-11-26T02:00:00Z'; return [w]; }, /edited/],
    ['an ACCEPT by a reader', (w) => { w.comments[0].user.login = 'reader'; return [w]; }, /by someone with write access/],
    ['a same-tree head on another parent', (w) => { w.pr.head.sha = H3; w.parents[H3] = [DEVH]; return [w]; }, /not an empty commit on top of it/],
    ['an ACCEPT posted after the command', (w) => { w.comments[0].id = 60; return [w]; }, /No `REVIEW ACCEPT/],
    ['a running check', (w) => { w.runs[H1] = [{ id: 1, name: 'build', status: 'in_progress', app: { slug: 'github-actions' } }]; return [w]; }, /still running/],
    ['a failed check', (w) => { w.runs[H1] = [{ id: 1, name: 'build', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } }]; return [w]; }, /Checks failed.*build=failure/],
    ['a failed commit status', (w) => { w.statuses[H1] = [{ context: 'review/codex', state: 'failure' }]; return [w]; }, /Commit statuses failed.*review\/codex/],
    ['a missing required check', (w) => { w.rules[0].parameters.required_status_checks.push({ context: 'gate' }); return [w]; }, /gate: missing/],
    ['no readable required checks', (w) => { w.rules = []; return [w]; }, /No required checks are readable/],
    ['an unreadable ruleset', (w) => { w.rules = null; return [w]; }, /rules of dev are unreadable/],
    ['an invalid dev method', (w) => [w, command(H1), { devMergeMethod: 'rebase', staleGate: 'off' }], /not squash or merge/],
    ['an invalid stale-gate value', (w) => [w, command(H1), { staleGate: 'maybe' }], /not on or off/],
    ['a ci-full body with the stale gate on', (w) => { w.pr.body = 'ci-full PASS abcdef12 run 1'; return [w, command(H1), { staleGate: 'on' }]; }, /ci-full mode/],
  ];
  for (const [name, setup, re] of cases) {
    const [w, cmd, policy] = setup(world());
    const v = await judge(w, cmd || command(H1), policy || { devMergeMethod: 'merge', staleGate: 'off' });
    ok(`refuses ${name}`, refused(v, re), JSON.stringify(v));
  }
  {
    const w = world();
    w.comments.push({ id: 11, user: { login: 'reader' }, body: `REVIEW CHANGES ${H1}`, html_url: 'u11' });
    ok('a reader\'s CHANGES does not block a merge', (await judge(w)).ok === true);
  }
  {
    const w = world();
    const temp = tmp();
    fs.writeFileSync(path.join(temp, 'merge-verdict.json'), JSON.stringify(await judge(w)));
    fs.writeFileSync(path.join(temp, 'merge-policy.json'), JSON.stringify({ staleGate: 'off' }));
    await runStep('Post review/independent', w, temp);
    w.comments.push({ id: 70, user: { login: 'reviewer' }, body: `REVIEW CHANGES ${H1}\nfound a bug`, html_url: 'u70' });
    const re = await runStep('Recheck before the merge', w, temp);
    ok('the recheck refuses a writer\'s CHANGES posted after the judge', re.outputs.ok !== 'true' && /newer review/.test((result(temp) || {}).reason || ''));
  }
  {
    const w = world(); w.pr.head.sha = H3; // same tree as H1: an empty "re-run checks" commit
    const v = await judge(w, command(H1));
    ok('a same-tree head is carried', v.ok === true && v.carried === true && v.headSha === H3 && /Carried to cccccccc/.test(v.summary));
  }
  {
    const w = world();
    w.rules[0].parameters.required_status_checks.push({ context: 'gate' });
    w.runs[H1] = [
      { id: 1, name: 'gate', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { id: 2, name: 'gate', status: 'completed', conclusion: 'failure', app: { slug: 'marvinamiranda-checks' } },
    ];
    ok('the Checks App shadow is ignored when the Actions copy succeeded', (await judge(w)).ok === true);
  }
  {
    const w = world();
    w.runs[H1] = [{ id: 5, name: 'review/independent', status: 'completed', conclusion: 'success', app: { id: 999, slug: 'someone' } }];
    const temp = tmp();
    fs.writeFileSync(path.join(temp, 'merge-verdict.json'), JSON.stringify(await judge(w)));
    // The Reviewer App posts (id 1000+), then a foreign App posts a newer same-name success.
    await runStep('Post review/independent', w, temp);
    w.runs[H1].push({ id: 5000, name: 'review/independent', status: 'completed', conclusion: 'success', app: { id: 999, slug: 'someone' } });
    fs.writeFileSync(path.join(temp, 'merge-policy.json'), JSON.stringify({ staleGate: 'off' }));
    const re = await runStep('Recheck before the merge', w, temp);
    ok('the recheck refuses a newer same-name run from another App than the pinned one', re.outputs.ok !== 'true' && /another App/.test((result(temp) || {}).reason || ''));
  }
  {
    const w = world();
    const temp = tmp();
    fs.writeFileSync(path.join(temp, 'merge-verdict.json'), JSON.stringify(await judge(w)));
    fs.writeFileSync(path.join(temp, 'merge-policy.json'), JSON.stringify({ staleGate: 'off' }));
    await runStep('Post review/independent', w, temp);
    w.pr.head.sha = H2;
    const re = await runStep('Recheck before the merge', w, temp);
    ok('the recheck refuses a head that moved after the review was posted', re.outputs.ok !== 'true' && /head moved/.test((result(temp) || {}).reason || ''));
  }
  {
    const w = world();
    const r = await runJob(w, { env: { keyEnv: { AGENT_APP_ID: '999' } } });
    ok('an environment naming another Agent App id refuses before any token', /must be 5075705/.test((r.result || {}).reason || '') && !w.calls.some((c) => c.name === 'check'));
  }
  {
    const w = world();
    const r = await runJob(w, { env: { keyEnv: { RUNNER_NAME: 'wsl-3' } } });
    ok('a runner outside the runner-name-pattern refuses before any key is used', /does not match the runner-name-pattern/.test((r.result || {}).reason || '') && !w.calls.some((c) => c.name === 'check'));
  }
  {
    const w = world();
    w.comments.push({ id: 11, user: { login: 'flaky' }, body: `REVIEW CHANGES ${H1}`, html_url: 'u11' });
    const g = fakeGithub(w);
    const real = g.rest.repos.getCollaboratorPermissionLevel;
    g.rest.repos.getCollaboratorPermissionLevel = async (a) => { if (a.username === 'flaky') throw httpError(502); return real(a); };
    const v = await lib.judge({ github: g, owner: OWNER, repo: REPO, prNumber: 7, comment: command(H1), policy: { devMergeMethod: 'merge', staleGate: 'off' } });
    ok('a permission lookup outage on a CHANGES author refuses instead of dropping it', refused(v, /cannot be weighed/));
  }
  {
    const w = world();
    const r = await runJob(w, { keys: false });
    ok('missing App keys: FAIL, nothing posted', /PRIVATE_KEY is empty/.test((r.result || {}).reason || '') && !w.calls.some((c) => c.name === 'check'));
  }

  // ------------------------------------------------------------ stale gate (#849) -------------------------------------
  const gateWorld = (suiteCreated, devHead = DEVH) => {
    const w = world();
    w.refs['heads/dev'] = devHead;
    w.runs[H1] = [{ id: 1, name: 'gate', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 77 } }];
    w.suites[77] = suiteCreated;
    return w;
  };
  ok('stale gate on: a gate that started after the merge ref on the current base passes',
    (await judge(gateWorld('2026-11-26T01:05:00Z'), command(H1), { staleGate: 'on' })).ok === true);
  ok('stale gate on: a gate older than the merge ref refuses',
    refused(await judge(gateWorld('2026-11-26T00:55:00Z'), command(H1), { staleGate: 'on' }), /did not start after the merge ref/));
  ok('stale gate on: a base that moved since refuses',
    refused(await judge(gateWorld('2026-11-26T01:05:00Z', 'c'.repeat(40)), command(H1), { staleGate: 'on' }), /is now cccccccc/));
  ok('stale gate on: no gate run refuses', refused(await judge(world(), command(H1), { staleGate: 'on' }), /No successful 'gate' run/));
  ok('stale gate off: no gate run is fine', (await judge(world(), command(H1), { staleGate: 'off' })).ok === true);

  // ------------------------------------------------------------ the merge call ----------------------------------------
  {
    const w = world();
    w.mergeAnswers = [httpError(405, 'Base branch was modified. Review and try the merge again.')];
    const r = await runJob(w);
    ok('a base-modified answer is retried and merges', r.result.state === 'merged' && w.calls.filter((c) => c.name === 'merge').length === 2);
  }
  {
    const w = world();
    w.mergeAnswers = [httpError(405, 'Base branch was modified.')];
    const r = await runJob(w, { env: { STALE_GATE: 'on' } });
    // The stale gate is on and there is no gate run, so the judge already refuses: build one that passes.
    ok('stale gate on: the judge refuses before a merge call when no gate ran', r.result.state === 'refused' && !w.calls.some((c) => c.name === 'merge'));
    const g = gateWorld('2026-11-26T01:05:00Z');
    g.mergeAnswers = [httpError(405, 'Base branch was modified.')];
    const r2 = await runJob(g, { env: { STALE_GATE: 'on' } });
    ok('stale gate on: a base that moved during the merge refuses instead of retrying',
      r2.result.state === 'refused' && /stale-gate rule/.test(r2.result.reason) && g.calls.filter((c) => c.name === 'merge').length === 1);
  }
  {
    const w = world();
    const err = httpError(405, 'Base branch was modified.');
    w.mergeAnswers = [err];
    // A hold label lands between the first merge call and the retry.
    w.onMerge = () => { w.pr.labels = [{ name: 'hold' }]; };
    const r = await runJob(w);
    ok('a retry after a base move refuses when the PR was put on hold meanwhile',
      r.result.state === 'refused' && /changed while retrying/.test(r.result.reason) && w.calls.filter((c) => c.name === 'merge').length === 1);
  }
  {
    const w = world();
    w.issues[3] = { state: 'closed', state_reason: 'completed' };
    await runJob(w);
    ok('done in dev still sets the Project status of an issue GitHub already closed',
      w.calls.some((c) => c.name === 'graphql' && c.args.oid === 'o-dev') && !w.calls.some((c) => c.name === 'update'));
  }
  {
    const w = world();
    w.pr.body = 'This leaves #3 unresolved #3 and prefixes #3';
    await runJob(w);
    ok('done in dev needs a whole closing word', !w.calls.some((c) => c.name === 'update' || c.name === 'graphql'));
  }
  {
    const w = world();
    w.mergeAnswers = [httpError(405, 'Required status check "review/independent" is expected.')];
    const r = await runJob(w);
    ok('the superseded-suite refusal says to push an empty commit', /Push an empty commit/.test(r.result.reason) && r.report.startsWith('FAIL '));
  }
  {
    const w = world();
    w.mergeAnswers = [httpError(405, 'Waiting on code owner review from someone.')];
    const r = await runJob(w);
    ok('a code-owner block is refused (no owner bypass in CI)', /owner bypass/.test(r.result.reason));
  }
  {
    const w = world();
    const temp = tmp();
    await runStep('Report on the pull request', w, temp);
    const body = (w.calls.find((c) => c.name === 'comment') || { args: {} }).args.body || '';
    ok('a job that stopped before a verdict still says FAIL on the PR', body.startsWith('FAIL the merge job stopped before a verdict'));
  }
  {
    const inline = /const re = (\/.*\/gi);/.exec(script(byName('Done in dev')));
    const body = 'Closes #3, fixes ThruuAi/thruu-sale#4 and Resolves https://github.com/ThruuAi/omni237/issues/9';
    const fromLib = lib.closingRefs(body, OWNER, REPO).map((r) => `${r.owner}/${r.repo}#${r.number}`).sort().join(',');
    ok('the inline done-in-dev grammar equals the module\'s', inline && fromLib === 'ThruuAi/omni237#9,ThruuAi/thruu-sale#3,ThruuAi/thruu-sale#4'
      && inline[1] === /const re = (\/.*\/gi);/.exec(fs.readFileSync(LIB, 'utf8'))[1]);
  }

  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.log(`not ok - the suite crashed: ${error && error.stack}`); process.exit(1); });
