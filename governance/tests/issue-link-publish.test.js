#!/usr/bin/env node
'use strict';

// .github/workflows/issue-link-publish.yml: the reusable workflow that posts
// `governance/issue-link` as the Checks App from an adopted repository's
// `workflow_run` job (Epic marvinamiranda/.github#7, Task #10).
//
//   node governance/tests/issue-link-publish.test.js
//
// Static: the shape that keeps the Checks App key away from pull request code
// (the custody review of .github#18 asked for a contract test). Behavioural:
// the two inline scripts run against a fake API client and the real
// governance/issue-link.js. Needs python3 with PyYAML, as pr-governance's does.
//
// ISSUE_LINK_PUBLISH_WORKFLOW / PR_GOVERNANCE_WORKFLOW point at other copies of
// the workflows, which is how a deliberately broken copy is shown to turn this
// suite red (see the mutation proof in the pull request).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const PUBLISH = process.env.ISSUE_LINK_PUBLISH_WORKFLOW
  ? path.resolve(process.env.ISSUE_LINK_PUBLISH_WORKFLOW)
  : path.join(WORKFLOWS, 'issue-link-publish.yml');
const GOVERNANCE = process.env.PR_GOVERNANCE_WORKFLOW
  ? path.resolve(process.env.PR_GOVERNANCE_WORKFLOW)
  : path.join(WORKFLOWS, 'pr-governance.yml');

function load(file) {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = spawnSync('python3', ['-c', 'import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', file], { encoding: 'utf8' });
  if (parsed.status !== 0) { console.log(`not ok - ${path.basename(file)} parses: ${parsed.stderr.trim()}`); process.exit(1); }
  return { text, doc: JSON.parse(parsed.stdout) };
}

let failed = 0;
let total = 0;
function ok(name, condition, detail = '') {
  total += 1;
  if (condition) console.log(`ok - ${name}`);
  else { failed += 1; console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`); }
}

const { text, doc } = load(PUBLISH);
const governance = load(GOVERNANCE);

const job = (doc.jobs && doc.jobs.publish) || {};
const steps = job.steps || [];
const script = (s) => (s && s.with && typeof s.with.script === 'string' ? s.with.script : '');
const stepText = (s) => JSON.stringify(s);
const byName = (name) => steps.find((s) => s.name === name);
const indexOfStep = (name) => steps.findIndex((s) => s.name === name);
const BEGIN = /\/\/ BEGIN verify-pin[^\n]*\n/;
const END = /\n[ \t]*\/\/ END verify-pin/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MINTED = '${{ steps.checks-app.outputs.token }}';

const verify = byName('Verify the pin');
const fetchStep = byName('Fetch the shared matcher');
const judgeStep = byName('Judge the pull request');
const keyCheck = byName('Require the Checks App key');
const mint = byName('Mint the Checks App token');
const post = byName('Publish governance/issue-link');
ok('the six steps exist', [verify, fetchStep, judgeStep, keyCheck, mint, post].every(Boolean));

// ------------------------------------------------ trigger and inputs ------
const call = (doc.on || doc[true] || {}).workflow_call;
ok('it is a reusable workflow and nothing else', call && Object.keys(doc.on || doc[true]).join() === 'workflow_call');
const inputs = (call && call.inputs) || {};
ok('only the named optional Checks App key is declared for cross-repo forwarding', call && call.secrets && Object.keys(call.secrets).join() === 'CHECKS_APP_PRIVATE_KEY' && call.secrets.CHECKS_APP_PRIVATE_KEY.required === false);
ok('runs-on is required and has no default', inputs['runs-on'] && inputs['runs-on'].required === true && !('default' in inputs['runs-on']));
ok('governance-ref is required', inputs['governance-ref'] && inputs['governance-ref'].required === true);
ok('the workflow names no hosted runner label', !/ubuntu-|macos-|windows-/.test(text.replace(/^\s*#.*$/gm, '')));
ok('the job runs on the runner the caller passes', job['runs-on'] === '${{ fromJSON(inputs.runs-on) }}');

// ------------------------------------------------ the event guard ---------
ok('the job runs only for the completion of a pull_request run',
  job.if === "github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request'", String(job.if));

// ------------------------------------------------ permissions, environment
ok('the GITHUB_TOKEN reads and cannot write a check',
  JSON.stringify(job.permissions) === JSON.stringify({ contents: 'read', issues: 'read', 'pull-requests': 'read' }), JSON.stringify(job.permissions));
ok('no permission block at any level grants checks or write',
  !/^\s*checks\s*:/m.test(text.replace(/^\s*#.*$/gm, '')) && !/:\s*write\b/.test(JSON.stringify(doc.permissions || {}) + JSON.stringify(job.permissions || {})));
ok('the job is in the governance-checks environment, without a deployment record',
  job.environment && job.environment.name === 'governance-checks' && job.environment.deployment === false, JSON.stringify(job.environment));
ok('no other job exists', Object.keys(doc.jobs || {}).join() === 'publish');

// ------------------------------------------------ pins ------------------
const uses = steps.map((s) => s.uses).filter(Boolean);
ok('every action is pinned to a full commit SHA', uses.length === 6 && uses.every((u) => FULL_SHA.test(u.split('@')[1] || '')), uses.join(', '));
ok('only first-party actions are used', uses.every((u) => /^actions\//.test(u)), uses.join(', '));
ok('no setup-* action (the gate VM has no toolcache)', uses.every((u) => !/\/setup-/.test(u)));

// ------------------------------------------------ nothing of the PR runs -
ok('there is no run: step, so no shell', steps.every((s) => !('run' in s)));
ok('no script carries a ${{ }} expression: everything reaches it as env or event data',
  steps.every((s) => !/\$\{\{/.test(script(s))), 'a ${{ }} expression sits inside a script');
const checkouts = steps.filter((s) => /^actions\/checkout@/.test(s.uses || ''));
ok('there is exactly one checkout, and it is of ThruuAi/.github at governance-ref, not of the caller',
  checkouts.length === 1 && checkouts[0].with.repository === 'ThruuAi/.github'
    && checkouts[0].with.ref === '${{ inputs.governance-ref }}' && checkouts[0].with.path === '.org-governance'
    && checkouts[0].with['persist-credentials'] === false, JSON.stringify(checkouts.map((c) => c.with)));
ok('the checkout takes only governance/issue-link.js', checkouts[0] && checkouts[0].with['sparse-checkout'] === 'governance/issue-link.js');
ok('the workflow never checks out or runs the pull request head',
  !/refs\/pull|pull_request\.head|head_ref/.test(text.replace(/^\s*#.*$/gm, ''))
    && !/GITHUB_WORKSPACE/.test(script(judgeStep)));
ok('the workflow run branch and head repository remain API data, never checkout or interpolation',
  checkouts.every((s) => !/head_branch|head_repository|head\.repo/.test(stepText(s)))
    && !/\$\{\{|\beval\s*\(|\bexec\s*\(|child_process/.test(script(judgeStep))
    && !/\brun\s*:/.test(text.replace(/^\s*#.*$/gm, '')));

// ------------------------------------------------ run limits ------------
ok('the job has a timeout of at most 10 minutes', typeof job['timeout-minutes'] === 'number' && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 10, String(job['timeout-minutes']));
ok('two runs for one commit queue, never cancel, and the workflow says so itself',
  job.concurrency && job.concurrency.group === 'issue-link-publish-${{ github.event.workflow_run.head_sha }}' && job.concurrency['cancel-in-progress'] === false,
  JSON.stringify(job.concurrency));
ok('no step runs on always(), failure() or cancelled(): the mint and post need a verdict from a verified pin',
  steps.every((s) => !/always\(|failure\(|cancelled\(|success\(/.test(s.if || '')), JSON.stringify(steps.map((s) => s.if)));

// ------------------------------------------------ ordering ---------------
const at = { verify: indexOfStep('Verify the pin'), fetch: indexOfStep('Fetch the shared matcher'), judge: indexOfStep('Judge the pull request'),
  key: indexOfStep('Require the Checks App key'), mint: indexOfStep('Mint the Checks App token'), post: indexOfStep('Publish governance/issue-link') };
ok('order: verify, fetch, judge, mint, post', at.verify === 0 && at.verify < at.fetch && at.fetch < at.judge && at.judge < at.key && at.key < at.mint && at.mint < at.post, JSON.stringify(at));
ok('the pin step has the id pin, and its env is the workflow commit, the workflow repository and governance-ref',
  verify && verify.id === 'pin' && verify.env.SELF_SHA === '${{ job.workflow_sha }}' && verify.env.SELF_REPOSITORY === '${{ job.workflow_repository }}'
    && verify.env.GOVERNANCE_REF === '${{ inputs.governance-ref }}', verify && JSON.stringify(verify.env));
ok('the workflow never reads github.workflow_sha (the caller\'s commit)', !/github\.workflow_sha|GITHUB_WORKFLOW_SHA/.test(text));
for (const [label, s] of [['fetch', fetchStep], ['judge', judgeStep], ['key', keyCheck], ['mint', mint], ['post', post]]) {
  ok(`${label}: runs only when the pin verified`, s && /steps\.pin\.outputs\.ok\s*==\s*'true'/.test(s.if || ''), s && s.if);
}
for (const [label, s] of [['key', keyCheck], ['mint', mint], ['post', post]]) {
  ok(`${label}: runs only after the judge produced a verdict`, s && /steps\.judge\.outputs\.judged\s*==\s*'true'/.test(s.if || ''), s && s.if);
}
ok('the judge step has the id judge', judgeStep && judgeStep.id === 'judge');
ok('a failed pin is not answered with a check: nothing in the pin step posts', verify && !/check-runs|checks\.create|github\.request/.test(script(verify)));
ok('a failed pin fails the job (nothing is posted, no token minted)', verify && /core\.setFailed\(problem\)/.test(script(verify)));

// ------------------------------------------------ the key ----------------
const KEY = /CHECKS_APP_PRIVATE_KEY/;
ok('only the inline key check and mint name the key secret', steps.filter((s) => KEY.test(stepText(s))).length === 2 && keyCheck && KEY.test(stepText(keyCheck)) && mint && KEY.test(stepText(mint)));
for (const [label, step] of [['mint', mint], ['post', post]]) {
  ok(`${label}: cannot run without a nonempty verified key`, step && /steps\.key\.outputs\.ready\s*==\s*'true'/.test(step.if || ''), step && step.if);
}
ok('key check is inline trusted code, with no external module, API call or expression in its script', keyCheck && keyCheck.id === 'key' && keyCheck.uses === 'actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b' && !/require\(|github\.|\$\{\{/.test(script(keyCheck)));
ok('key presence receives only the environment secret under its explicit name', keyCheck && keyCheck.env.CHECKS_PRIVATE_KEY === '${{ secrets.CHECKS_APP_PRIVATE_KEY }}');
ok('the mint step asks for this repository only, checks write only',
  mint && mint.with['repositories'] === '${{ github.event.repository.name }}' && mint.with['owner'] === '${{ github.repository_owner }}'
    && mint.with['permission-checks'] === 'write'
    && Object.keys(mint.with).filter((k) => k.startsWith('permission-')).join() === 'permission-checks',
  mint && JSON.stringify(mint.with));
ok('the mint step reads the client id and key from the environment',
  mint && mint.with['client-id'] === '${{ vars.CHECKS_APP_CLIENT_ID }}' && mint.with['private-key'] === '${{ secrets.CHECKS_APP_PRIVATE_KEY }}');
ok('the minted token reaches exactly one step, the post, as its github-token',
  steps.filter((s) => stepText(s).includes('steps.checks-app.outputs.token')).length === 1 && post && post.with['github-token'] === MINTED);
ok('the fetched code never sees the minted token or any secret',
  [verify, fetchStep, judgeStep].every((s) => s && !/secrets\.|steps\.checks-app/.test(stepText(s))));
ok('only key presence and mint read the secrets context', steps.filter((s) => /secrets\./.test(stepText(s))).length === 2);
ok('the file takes no third-party secret, only the Checks App\'s',
  [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].every((m) => m[1] === 'CHECKS_APP_PRIVATE_KEY'));

// ------------------------------------------------ the one post ----------
const posts = steps.filter((s) => /check-runs|checks\.create|checks\.update|createCommitStatus|repos\.createStatus/.test(stepText(s)));
ok('exactly one step posts anything, and it is the post step', posts.length === 1 && posts[0] === post);
ok('the post uses the minted token, not the GITHUB_TOKEN', post && post.with['github-token'] === MINTED && !/GITHUB_TOKEN|github\.token/.test(stepText(post)));
ok('the workflow never creates a check through github.rest or checks.create anywhere', !/checks\.create|rest\.checks|github\.rest\.checks/.test(text));
ok('no step other than the post passes a github-token at all', steps.filter((s) => s.with && 'github-token' in s.with).length === 1);
ok('the post is a POST to check-runs for governance/issue-link',
  post && /github\.request\('POST \/repos\/\{owner\}\/\{repo\}\/check-runs'/.test(script(post)) && /name: 'governance\/issue-link'/.test(script(post)));
ok('the post takes the head from the verdict, not from the event', post && /head_sha: verdict\.headSha/.test(script(post)) && !/workflow_run/.test(script(post)));
ok('the verdict file lives in RUNNER_TEMP, outside the workspace',
  /RUNNER_TEMP/.test(script(judgeStep)) && /RUNNER_TEMP/.test(script(post)) && !/GITHUB_WORKSPACE/.test(text));

// ------------------------------------------------ the pin block ----------
const block = (t) => { const b = (t.split(BEGIN)[1] || '').split(END)[0]; return b.split('\n').map((l) => l.trim()).join('\n').trim(); };
const govScripts = Object.values(governance.doc.jobs).flatMap((j) => (j.steps || []).map(script)).filter((s) => BEGIN.test(s));
ok('pr-governance.yml still carries the pin check', govScripts.length >= 1);
ok('the pin check is byte-identical to pr-governance.yml\'s (whitespace-trimmed)',
  govScripts.length >= 1 && govScripts.every((g) => block(g) === block(script(verify))) && block(script(verify)).length > 200);

// ------------------------------------------------ no other workflow ------
const others = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f) && f !== 'issue-link-publish.yml');
for (const f of others) {
  const t = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
  ok(`${f}: names neither the governance-checks environment nor the Checks App key`, !/governance-checks|CHECKS_APP_/.test(t));
}

// ------------------------------------------------ behaviour --------------
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const HEAD = 'c'.repeat(40);
const HEAD2 = 'd'.repeat(40);
const HERE = 1001; // this repository's id in the fake payload
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-link-publish-'));
fs.symlinkSync(ROOT, path.join(work, '.org-governance'));
fs.mkdirSync(path.join(work, 'tmp'));
process.env.RUNNER_TEMP = path.join(work, 'tmp');
const verdictFile = path.join(work, 'tmp', 'issue-link-verdict.json');

function fakeCore() {
  const out = { failed: [], outputs: {}, summary: [] };
  return {
    out,
    setFailed: (m) => out.failed.push(String(m)),
    setOutput: (k, v) => { out.outputs[k] = v; },
    summary: { addHeading() { return this; }, addRaw(t) { out.summary.push(t); return this; }, async write() {} },
  };
}
// `bodies`: pull request number -> { body, head sha, closing issues }.
function fakeApi({ bodies = { 761: {} }, pullsGet = null, base = 'test', defaultBranch = 'test',
  openPages = [], listError = null, commitPages = [], existingChecks = [] } = {}) {
  const calls = [];
  const checks = [...existingChecks];
  const of = (n) => ({ body: 'Closes #742', head: HEAD, closing: [742], ...(bodies[n] || {}) });
  return {
    calls, checks,
    rest: {
      pulls: { get: async (a) => { calls.push(['pulls.get', a.pull_number]);
        if (pullsGet) return pullsGet(calls, a);
        const b = of(a.pull_number);
        return { data: { number: a.pull_number, state: 'open', draft: false, body: b.body,
          head: { ref: 'x', sha: b.head, repo: { id: HERE } },
          base: { ref: base, repo: { id: HERE } } } }; },
        list: async (a) => { calls.push(['pulls.list', a]);
          if (listError) throw listError;
          return { data: openPages[a.page - 1] || [] };
        } },
      repos: { get: async () => ({ data: { default_branch: defaultBranch } }),
        listPullRequestsAssociatedWithCommit: async (a) => {
          calls.push(['repos.listPullRequestsAssociatedWithCommit', a]);
          return { data: commitPages[a.page - 1] || [] };
        } },
      issues: { get: async () => ({ data: {} }) },
    },
    paginate: async (method, a) => {
      calls.push(['paginate', a]);
      const results = [];
      for (let page = 1; page <= 101; page++) {
        const response = await method({ ...a, page });
        if (!Array.isArray(response.data)) throw new Error('malformed association response');
        results.push(...response.data);
        if (response.data.length < 100) return results;
      }
      throw new Error('association pagination did not terminate');
    },
    graphql: async (q, v) => ({ repository: { pullRequest: { closingIssuesReferences: { totalCount: of(v.number).closing.length,
      nodes: of(v.number).closing.map((n) => ({ number: n, repository: { nameWithOwner: 'marvinamiranda/omni237' } })) } } } }),
    async request(route, params) { calls.push(['request', route, params]); checks.push(params); return { data: {} }; },
  };
}
const realRequire = require;
const requireFrom = (p) => (p.startsWith('.') ? realRequire(path.resolve(work, p)) : realRequire(p));
const listedPr = (number, repoId = HERE) => ({ number, base: { ref: 'test', repo: { id: repoId, name: 'omni237' } } });
const associatedPr = (number, overrides = {}) => ({ number, state: 'open', draft: false,
  head: { sha: HEAD, ref: 'x', repo: { id: HERE } },
  base: { ref: 'test', repo: { id: HERE } }, ...overrides });
const context = (pulls, extra = {}) => ({
  repo: { owner: 'marvinamiranda', repo: 'omni237' },
  payload: { repository: { id: HERE }, workflow_run: { event: 'pull_request', head_sha: HEAD,
    head_branch: 'x', head_repository: { id: HERE }, pull_requests: pulls, ...extra } },
});

async function runJudge(github, ctx, judgeOverride = null) {
  const core = fakeCore();
  fs.rmSync(verdictFile, { force: true });
  const injectedRequire = (p) => judgeOverride && p.endsWith('/issue-link.js') ? { judge: judgeOverride } : requireFrom(p);
  await new AsyncFunction('github', 'context', 'core', 'require', script(judgeStep))(github, ctx, core, injectedRequire);
  return { core, verdicts: fs.existsSync(verdictFile) ? JSON.parse(fs.readFileSync(verdictFile, 'utf8')) : null };
}
async function runPost(github) {
  const core = fakeCore();
  await new AsyncFunction('github', 'context', 'core', 'require', script(post))(github, context([listedPr(1)]), core, requireFrom);
  return core;
}
async function failurePostedOnRunHead(github, result, failJobAfterPost = false) {
  if (!result.verdicts || result.verdicts.length !== 1 || result.verdicts[0].ok !== false
      || result.verdicts[0].headSha !== HEAD || result.core.out.failed.length !== 0
      || result.core.out.outputs.judged !== 'true') return false;
  const core = await runPost(github);
  const last = github.checks.at(-1);
  return core.out.failed.length === (failJobAfterPost ? 1 : 0)
    && (!failJobAfterPost || /no verdict/i.test(core.out.failed[0]))
    && last && last.head_sha === HEAD && last.conclusion === 'failure';
}

// A fake for the pin step's own API calls (the same shape pr-governance's test uses).
const TEST_TIP = '69b68cd158547974bb71b1fdc01ba7a89629c46c';
const SELF = 'eded4bf1f05be3a33a354795bac37d77105bac16';
// It knows only ThruuAi/.github: any other owner or repository answers 404, as
// GitHub would for a repository the pin does not live in.
function fakePinApi(status, branch = TEST_TIP) {
  const fail = (code) => { const e = new Error('HTTP error'); e.status = code; throw e; };
  const root = (a) => { if (a.owner !== 'ThruuAi' || a.repo !== '.github') fail(404); };
  return { rest: { repos: {
    getBranch: async (a) => { root(a); if (typeof branch === 'number') fail(branch); return { data: { name: a.branch, commit: { sha: branch } } }; },
    compareCommitsWithBasehead: async (a) => { root(a); if (typeof status === 'number') fail(status); return { data: { status } }; },
  } } };
}
async function runPin(github, env) {
  const core = fakeCore();
  await new AsyncFunction('github', 'context', 'core', 'process', script(verify))(github, {}, core, { env });
  return core;
}

(async () => {
  if (!judgeStep || !post || !verify) { console.log('not ok - behaviour: the steps are missing'); process.exit(1); }

  // ---- the pin step's own script, call site included --------------------
  const pinEnv = (o = {}) => ({ SELF_SHA: SELF, SELF_REPOSITORY: 'ThruuAi/.github', GOVERNANCE_REF: SELF, ...o });
  for (const [label, github, env, pass] of [
    ['a pin that is test\'s head', fakePinApi('identical'), pinEnv(), true],
    ['a pin behind test', fakePinApi('behind'), pinEnv(), true],
    ['a governance-ref that is not the uses: pin', fakePinApi('identical'), pinEnv({ GOVERNANCE_REF: 'b'.repeat(40) }), false],
    ['a pin that diverged from test (a fork or branch commit)', fakePinApi('diverged'), pinEnv(), false],
    ['a pin ahead of test (an unmerged commit)', fakePinApi('ahead'), pinEnv(), false],
    ['a workflow running from another repository', fakePinApi('identical'), pinEnv({ SELF_REPOSITORY: 'someone/.github' }), false],
    ['a workflow running from the former root, marvinamiranda/.github', fakePinApi('identical'), pinEnv({ SELF_REPOSITORY: 'marvinamiranda/.github' }), false],
    ['a workflow running from a lookalike, ThruuAi/.github-evil', fakePinApi('identical'), pinEnv({ SELF_REPOSITORY: 'ThruuAi/.github-evil' }), false],
    ['a workflow reported in lower case, thruuai/.github', fakePinApi('identical'), pinEnv({ SELF_REPOSITORY: 'thruuai/.github' }), true],
    ['test that cannot be read', fakePinApi('identical', 404), pinEnv(), false],
  ]) {
    const core = await runPin(github, env);
    ok(`pin step: ${label} sets ok=${pass}${pass ? '' : ' and fails the job'}`,
      core.out.outputs.ok === String(pass) && (pass ? core.out.failed.length === 0 : core.out.failed.length === 1), JSON.stringify(core.out));
  }

  for (const value of ['', '   ', 'test-private-key-marker']) {
    const saved = process.env.CHECKS_PRIVATE_KEY;
    process.env.CHECKS_PRIVATE_KEY = value;
    const core = fakeCore();
    try {
      await new AsyncFunction('core', script(keyCheck))(core);
    } finally {
      if (saved === undefined) delete process.env.CHECKS_PRIVATE_KEY;
      else process.env.CHECKS_PRIVATE_KEY = saved;
    }
    const missing = !value.trim();
    ok(`key presence: ${missing ? 'empty/whitespace fails loudly without authorizing mint or post' : 'nonempty authorizes without exposing key'}`,
      missing ? core.out.failed.length === 1 && /empty/.test(core.out.failed[0]) && core.out.outputs.ready !== 'true'
        : core.out.failed.length === 0 && core.out.outputs.ready === 'true' && !JSON.stringify(core.out).includes(value));
  }
  // ---- one pull request ---------------------------------------------------
  let gh = fakeApi();
  let r = await runJudge(gh, context([listedPr(761)]));
  ok('judge: a pull request that closes an issue is a success on its current head',
    r.verdicts && r.verdicts.length === 1 && r.verdicts[0].ok === true && r.verdicts[0].headSha === HEAD && r.core.out.failed.length === 0, JSON.stringify(r.verdicts));
  ok('judge: it read the pull request the run lists', gh.calls.some((c) => c[0] === 'pulls.get' && c[1] === 761));
  ok('judge: it posts nothing', !gh.calls.some((c) => c[0] === 'request'));
  ok('judge: it marks the verdict for the mint and post steps', r.core.out.outputs.judged === 'true');

  // ---- missing workflow_run association: recover only one bound live PR ----
  gh = fakeApi({ openPages: [[associatedPr(761)]] });
  r = await runJudge(gh, context([]));
  ok('recovery: one exact-SHA same-repository PR is judged after a fresh identity read',
    r.verdicts && r.verdicts.length === 1 && r.verdicts[0].ok === true && r.verdicts[0].headSha === HEAD
      && gh.calls.filter((c) => c[0] === 'pulls.get').length >= 3
      && gh.calls.some((c) => c[0] === 'paginate' && c[1].state === 'open' && c[1].head === 'marvinamiranda:x')
      && r.core.out.outputs.judged === 'true', JSON.stringify(r.core.out));

  const release = associatedPr(761, { head: { sha: HEAD, ref: 'test', repo: { id: HERE } },
    base: { ref: 'main', repo: { id: HERE } } });
  gh = fakeApi({ commitPages: [[associatedPr(760, { state: 'closed' })]], openPages: [[release]], base: 'main', pullsGet: () => ({ data: {
    number: 761, state: 'open', draft: false, body: 'Closes #742', head: release.head, base: release.base,
  } }) });
  r = await runJudge(gh, context([], { head_branch: 'test' }));
  ok('recovery: a release PR from the same default-branch head to main is valid',
    r.verdicts && r.verdicts[0].ok === true && r.verdicts[0].headSha === HEAD
      && !gh.calls.some((c) => c[0] === 'repos.listPullRequestsAssociatedWithCommit')
      && gh.calls.some((c) => c[0] === 'pulls.list' && c[1].head === 'marvinamiranda:test'), JSON.stringify(r.core.out));

  for (const [label, candidate, runExtra] of [
    ['wrong SHA', associatedPr(761, { head: { sha: HEAD2, ref: 'x', repo: { id: HERE } } })],
    ['wrong head repository', associatedPr(761, { head: { sha: HEAD, ref: 'x', repo: { id: 2 } } })],
    ['fork', associatedPr(761, { head: { sha: HEAD, ref: 'x', repo: { id: 2 } }, base: { ref: 'test', repo: { id: HERE } } })],
    ['wrong base repository', associatedPr(761, { base: { ref: 'test', repo: { id: 2 } } })],
    ['wrong branch', associatedPr(761, { head: { sha: HEAD, ref: 'other', repo: { id: HERE } } })],
    ['missing head ref', associatedPr(761, { head: { sha: HEAD, repo: { id: HERE } } })],
    ['malformed candidate', { number: 761, state: 'open', head: { sha: HEAD } }],
    ['missing run branch', associatedPr(761), { head_branch: undefined }],
    ['blank run branch', associatedPr(761), { head_branch: '   ' }],
    ['missing run repository', associatedPr(761), { head_repository: undefined }],
    ['cross-repository run', associatedPr(761), { head_repository: { id: 2 } }],
  ]) {
    gh = fakeApi({ openPages: [[candidate]] });
    r = await runJudge(gh, context([], runExtra));
    ok(`recovery: ${label} fails closed with a failure check on the run head`,
      await failurePostedOnRunHead(gh, r)
        && (label.startsWith('missing run') || label === 'blank run branch' || label === 'cross-repository run'
          ? !gh.calls.some((c) => c[0] === 'paginate')
          : gh.calls.some((c) => c[0] === 'paginate')), JSON.stringify(r.core.out));
  }

  gh = fakeApi({ openPages: [[associatedPr(761), associatedPr(762)]] });
  r = await runJudge(gh, context([]));
  ok('recovery: two open exact candidates are ambiguous and cannot pass',
    await failurePostedOnRunHead(gh, r) && !gh.calls.some((c) => c[0] === 'pulls.get')
      && gh.calls.some((c) => c[0] === 'paginate'));

  gh = fakeApi({ openPages: [[associatedPr(761), { number: 762, state: 'open', head: { sha: HEAD } }]] });
  r = await runJudge(gh, context([]));
  ok('recovery: a malformed second candidate cannot hide behind one valid candidate',
    await failurePostedOnRunHead(gh, r) && !gh.calls.some((c) => c[0] === 'pulls.get'));

  gh = fakeApi({ openPages: [Array.from({ length: 100 }, (_, n) => associatedPr(n + 1, { head: { sha: HEAD2, ref: 'x', repo: null } })), [associatedPr(761)]] });
  r = await runJudge(gh, context([]));
  ok('recovery: page two is read before selecting the unique open candidate',
    r.verdicts && r.verdicts[0].ok === true
      && gh.calls.filter((c) => c[0] === 'pulls.list').length === 2,
    JSON.stringify(r.core.out));

  gh = fakeApi({ openPages: [[associatedPr(760, { state: 'closed', head: { sha: HEAD, ref: 'x', repo: null } }),
    associatedPr(762, { head: { sha: HEAD, ref: 'x', repo: { id: 2 } } }),
    associatedPr(763, { head: { sha: HEAD2, ref: 'x', repo: null } }), associatedPr(761)]] });
  r = await runJudge(gh, context([]));
  ok('recovery: irrelevant closed, fork and other-SHA rows cannot DoS the unique eligible PR',
    r.verdicts && r.verdicts[0].ok === true && r.verdicts[0].headSha === HEAD);

  gh = fakeApi({ openPages: [[associatedPr(761)]], pullsGet: (calls, a) => {
    const read = calls.filter((c) => c[0] === 'pulls.get').length;
    return { data: { ...associatedPr(a.pull_number), body: 'Closes #742',
      head: { sha: read === 1 ? HEAD2 : HEAD, ref: 'x', repo: { id: HERE } } } };
  } });
  r = await runJudge(gh, context([]));
  ok('recovery: moved identity on the FIRST fresh read fails even if later reads would match',
    await failurePostedOnRunHead(gh, r) && gh.calls.filter((c) => c[0] === 'pulls.get').length === 1);

  gh = fakeApi({ openPages: [[associatedPr(761)]], pullsGet: (calls, a) => {
    const read = calls.filter((c) => c[0] === 'pulls.get').length;
    return { data: { ...associatedPr(a.pull_number), body: 'Closes #742',
      base: { ref: read === 1 ? 'main' : 'test', repo: { id: HERE } } } };
  } });
  r = await runJudge(gh, context([]));
  ok('recovery: base retarget on the FIRST fresh read fails before judging',
    await failurePostedOnRunHead(gh, r) && gh.calls.filter((c) => c[0] === 'pulls.get').length === 1);

  gh = fakeApi({ openPages: [[associatedPr(761)]], pullsGet: (calls, a) => {
    const read = calls.filter((c) => c[0] === 'pulls.get').length;
    return { data: { ...associatedPr(a.pull_number), body: 'Closes #742',
      base: { ref: read >= 3 ? 'main' : 'test', repo: { id: HERE } } } };
  } });
  r = await runJudge(gh, context([]));
  ok('recovery: base retarget after judging fails on the run head',
    await failurePostedOnRunHead(gh, r) && gh.calls.filter((c) => c[0] === 'pulls.get').length >= 3);

  gh = fakeApi({ openPages: [[associatedPr(761)]], pullsGet: () => {
    const error = new Error('do not publish this API response'); error.status = 503; throw error;
  } });
  r = await runJudge(gh, context([]));
  ok('recovery: fresh identity API failure posts a bounded failure on the run head',
    await failurePostedOnRunHead(gh, r) && gh.calls.filter((c) => c[0] === 'pulls.get').length === 1
      && !/do not publish/.test(r.verdicts[0].summary));

  const apiError = new Error('association API down'); apiError.status = 502;
  gh = fakeApi({ listError: apiError, existingChecks: [{ head_sha: HEAD, conclusion: 'success' }] });
  r = await runJudge(gh, context([]));
  ok('recovery: list HTTP 502 posts failure on the run head over an older App success',
    await failurePostedOnRunHead(gh, r) && gh.checks.length === 2 && gh.checks[0].conclusion === 'success'
      && gh.checks[1].conclusion === 'failure' && gh.calls.some((c) => c[0] === 'paginate')
      && /HTTP 502/.test(r.verdicts[0].summary) && !/association API down/.test(r.verdicts[0].summary));

  gh = fakeApi({ openPages: [[associatedPr(761)]], pullsGet: (calls, a) => {
    const read = calls.filter((c) => c[0] === 'pulls.get').length;
    return { data: { ...associatedPr(a.pull_number), body: 'Closes #742',
      head: { sha: read >= 2 ? HEAD2 : HEAD, ref: 'x', repo: { id: HERE } } } };
  } });
  r = await runJudge(gh, context([]));
  ok('recovery: a force-push during the matcher cannot publish success on an unrelated head',
    await failurePostedOnRunHead(gh, r)
      && gh.calls.filter((c) => c[0] === 'pulls.get').length >= 2,
    JSON.stringify(r.core.out));

  gh = fakeApi({ openPages: [[associatedPr(761)]], pullsGet: (calls, a) => {
    const read = calls.filter((c) => c[0] === 'pulls.get').length;
    return { data: { ...associatedPr(a.pull_number), body: 'Closes #742',
      head: { sha: read === 2 ? HEAD2 : HEAD, ref: 'x', repo: { id: HERE } } } };
  } });
  r = await runJudge(gh, context([]));
  ok('recovery: the matcher verdict itself must name the run head even if the PR moves back',
    await failurePostedOnRunHead(gh, r)
      && gh.calls.filter((c) => c[0] === 'pulls.get').length === 2,
    JSON.stringify(r.core.out));

  gh = fakeApi({ openPages: [[associatedPr(761)]], pullsGet: (calls, a) => {
    const read = calls.filter((c) => c[0] === 'pulls.get').length;
    return { data: { ...associatedPr(a.pull_number), body: 'Closes #742', state: read >= 3 ? 'closed' : 'open' } };
  } });
  r = await runJudge(gh, context([]));
  ok('recovery: a PR closed after matching cannot authorize a success',
    await failurePostedOnRunHead(gh, r)
      && gh.calls.filter((c) => c[0] === 'pulls.get').length >= 3,
    JSON.stringify(r.core.out));

  gh = fakeApi({ openPages: [[associatedPr(761)]], pullsGet: (calls, a) => {
    const read = calls.filter((c) => c[0] === 'pulls.get').length;
    return { data: { ...associatedPr(a.pull_number), body: 'Closes #742',
      head: { sha: read >= 3 ? HEAD2 : HEAD, ref: 'x', repo: { id: HERE } } } };
  } });
  r = await runJudge(gh, context([]));
  ok('recovery: a force-push after matching cannot authorize a success',
    await failurePostedOnRunHead(gh, r)
      && gh.calls.filter((c) => c[0] === 'pulls.get').length >= 3,
    JSON.stringify(r.core.out));

  gh = fakeApi({ bodies: { 761: { body: 'no link here', closing: [] } } });
  r = await runJudge(gh, context([listedPr(761)]));
  ok('judge: a body with no closing keyword is a failure verdict', r.verdicts && r.verdicts[0].ok === false && r.verdicts[0].headSha === HEAD, JSON.stringify(r.verdicts));

  // ---- which pull requests are judged (F1) --------------------------------
  // Two open pull requests share one commit; one closes an issue, one does not.
  const two = { 761: {}, 762: { body: 'no link here', closing: [] } };
  for (const [label, order] of [['the passing one listed first', [761, 762]], ['the failing one listed first', [762, 761]]]) {
    gh = fakeApi({ bodies: two });
    r = await runJudge(gh, context(order.map((n) => listedPr(n))));
    ok(`judge: two pull requests on one commit, ${label}: every one is judged and the commit fails`,
      gh.calls.filter((c) => c[0] === 'pulls.get').length === 2 && r.verdicts.length === 1 && r.verdicts[0].ok === false
        && r.verdicts[0].headSha === HEAD && /#762/.test(r.verdicts[0].title), JSON.stringify(r.verdicts));
  }
  gh = fakeApi({ bodies: two });
  r = await runJudge(gh, context([listedPr(761), listedPr(762)]));
  await runPost(gh);
  ok('accepted commit-scoped contract: one unlinked PR on a shared head posts App failure',
    gh.calls.some((c) => c[0] === 'request' && c[2].head_sha === HEAD && c[2].conclusion === 'failure'));
  gh = fakeApi({ bodies: { 761: {}, 762: {} } });
  r = await runJudge(gh, context([listedPr(761), listedPr(762)]));
  ok('judge: two pull requests on one commit that both close an issue: one success',
    r.verdicts.length === 1 && r.verdicts[0].ok === true && /All 2 pull requests/.test(r.verdicts[0].title), JSON.stringify(r.verdicts));
  gh = fakeApi({ bodies: { 761: {}, 762: { head: HEAD2, body: 'no link', closing: [] } } });
  r = await runJudge(gh, context([listedPr(761), listedPr(762)]));
  ok('judge: pull requests on different commits get one verdict each, and one failure does not fail the other',
    r.verdicts.length === 2 && r.verdicts.find((v) => v.headSha === HEAD).ok === true && r.verdicts.find((v) => v.headSha === HEAD2).ok === false, JSON.stringify(r.verdicts));
  // A pull request of another repository is not this repository's to judge.
  gh = fakeApi({ bodies: two });
  r = await runJudge(gh, context([listedPr(762, 7777), listedPr(761)]));
  ok('judge: a listed pull request that targets another repository is not judged',
    gh.calls.filter((c) => c[0] === 'pulls.get').map((c) => c[1]).join() === '761' && r.verdicts.length === 1 && r.verdicts[0].ok === true, JSON.stringify(r.verdicts));
  for (const [label, pulls] of [['none', []], ['no list', undefined], ['only another repository\'s', [listedPr(9, 7777)]],
    ['a pull request with no base repository', [{ number: 9, base: { ref: 'test' } }]], ['a non-integer number', [{ ...listedPr(7), number: '7' }]], ['number zero', [{ ...listedPr(7), number: 0 }]]]) {
    gh = fakeApi();
    r = await runJudge(gh, context(pulls));
    ok(`judge: a run listing ${label} of this repository posts a failure on its known head`,
      await failurePostedOnRunHead(gh, r)
        && (label === 'none' || label === 'no list'
          ? gh.calls.some((c) => c[0] === 'paginate')
          : !gh.calls.some((c) => c[0] === 'paginate')), JSON.stringify(r.core.out));
  }
  gh = fakeApi();
  const noRepo = context([listedPr(761)]);
  delete noRepo.payload.repository;
  r = await runJudge(gh, noRepo);
  ok('judge: a payload that does not say which repository this is posts failure on the run head', await failurePostedOnRunHead(gh, r));
  // Two missing ids must not equal each other.
  gh = fakeApi();
  const neither = context([{ number: 761, base: { ref: 'test', repo: { name: 'omni237' } } }]);
  delete neither.payload.repository;
  r = await runJudge(gh, neither);
  ok('judge: no id on either side is not a match', await failurePostedOnRunHead(gh, r));

  gh = fakeApi({ openPages: [[associatedPr(761)]] });
  r = await runJudge(gh, context([], { head_sha: 'not-a-sha' }));
  ok('recovery: no valid run head fails the job without a post',
    r.core.out.failed.length === 1 && r.verdicts === null && r.core.out.outputs.judged === undefined
      && !gh.calls.some((c) => c[0] === 'request'));

  gh = fakeApi();
  r = await runJudge(gh, context([listedPr(761)], { pull_requests: { number: 761 } }));
  ok('judge: malformed run association posts failure on a valid run head', await failurePostedOnRunHead(gh, r));

  gh = fakeApi({ existingChecks: [{ head_sha: HEAD, conclusion: 'success' }] });
  r = await runJudge(gh, context([listedPr(761)]), async () => undefined);
  ok('judge: an undefined listed matcher result posts failure over older success then fails the job',
    await failurePostedOnRunHead(gh, r, true) && gh.checks.length === 2 && gh.checks[0].conclusion === 'success');

  gh = fakeApi({ openPages: [[associatedPr(761)]] });
  r = await runJudge(gh, context([]), async () => undefined);
  ok('recovery: an undefined matcher result posts failure on the run head then fails the job',
    await failurePostedOnRunHead(gh, r, true));

  // ---- the judge cannot run ----------------------------------------------
  gh = fakeApi({ pullsGet: (calls, a) => { if (calls.filter((c) => c[0] === 'pulls.get').length === 1) { const e = new Error('boom'); e.name = 'MatcherUnavailableError'; e.status = 502; throw e; }
    return { data: { head: { sha: HEAD2 } } }; } });
  r = await runJudge(gh, context([listedPr(761)]));
  ok('judge: an API error becomes a failure verdict on the pull request\'s head, not silence',
    r.verdicts && r.verdicts[0].ok === false && r.verdicts[0].headSha === HEAD2 && /502/.test(r.verdicts[0].summary) && /MatcherUnavailableError/.test(r.verdicts[0].summary) && !/boom/.test(r.verdicts[0].summary) && r.core.out.outputs.judged === 'true', JSON.stringify(r.verdicts));

  gh = fakeApi({ pullsGet: () => { const e = new Error('down'); e.status = 503; throw e; } });
  r = await runJudge(gh, context([listedPr(761)]));
  ok('judge: if the head cannot be read, the failure lands on the run\'s own head commit',
    r.verdicts && r.verdicts[0].ok === false && r.verdicts[0].headSha === HEAD, JSON.stringify(r.verdicts));
  r = await runJudge(gh, context([listedPr(761)], { head_sha: 'not-a-sha' }));
  ok('judge: if no head commit can be found at all, the job fails and nothing is written',
    r.verdicts === null && r.core.out.failed.length === 1 && r.core.out.outputs.judged === undefined, JSON.stringify(r.core.out));

  // ---- a crafted body cannot make the POST too big (F3) ----------------
  // A non-default base skips GitHub's lookup, and the summary lists every reference.
  const many = Array.from({ length: 12000 }, (_, i) => `Closes #${i + 1000}`).join('\n');
  gh = fakeApi({ bodies: { 761: { body: many } }, base: 'test', defaultBranch: 'main' });
  r = await runJudge(gh, context([listedPr(761)]));
  ok('judge: a summary over the API limit is cut, and says so',
    r.verdicts && r.verdicts[0].summary.length <= 60000 && /\(truncated\)$/.test(r.verdicts[0].summary), r.verdicts && String(r.verdicts[0].summary.length));

  // ---- the post ---------------------------------------------------------
  for (const [label, verdict, conclusion] of [
    ['success', { ok: true, title: 'Closes x', summary: 'fine', headSha: HEAD }, 'success'],
    ['failure', { ok: false, title: 'No closing issue link', summary: 'add one', headSha: HEAD }, 'failure'],
    ['a truthy non-boolean ok is not a success', { ok: 'yes', title: 't', summary: 's', headSha: HEAD }, 'failure'],
  ]) {
    fs.writeFileSync(verdictFile, JSON.stringify([verdict]));
    gh = fakeApi();
    const core = await runPost(gh);
    const req = gh.calls.filter((c) => c[0] === 'request');
    ok(`post: ${label} is published once, as ${conclusion}, on the verdict's head`,
      req.length === 1 && req[0][1] === 'POST /repos/{owner}/{repo}/check-runs' && req[0][2].name === 'governance/issue-link'
        && req[0][2].conclusion === conclusion && req[0][2].status === 'completed' && req[0][2].head_sha === HEAD
        && req[0][2].owner === 'marvinamiranda' && req[0][2].repo === 'omni237' && core.out.failed.length === 0, JSON.stringify(req));
  }
  fs.writeFileSync(verdictFile, JSON.stringify([{ ok: true, title: 'a', summary: 'a', headSha: HEAD }, { ok: false, title: 'b', summary: 'b', headSha: HEAD2 }]));
  gh = fakeApi();
  await runPost(gh);
  ok('post: one check run per head commit', gh.calls.filter((c) => c[0] === 'request').map((c) => `${c[2].head_sha.slice(0, 1)}:${c[2].conclusion}`).join() === 'c:success,d:failure');
  fs.writeFileSync(verdictFile, JSON.stringify([{ ok: false, title: 'x'.repeat(1000), summary: 'y'.repeat(200000), headSha: HEAD }]));
  gh = fakeApi();
  await runPost(gh);
  const sent = gh.calls.find((c) => c[0] === 'request');
  ok('post: whatever the verdict file holds, the summary sent is under the API limit and the title under 255',
    sent && sent[2].output.summary.length <= 60000 && /\(truncated\)$/.test(sent[2].output.summary) && sent[2].output.title.length <= 255,
    sent && `${sent[2].output.summary.length}/${sent[2].output.title.length}`);
  for (const [label, content] of [['missing', [{ ok: true, title: 't', summary: 's' }]], ['not a full sha', [{ ok: true, title: 't', summary: 's', headSha: 'abc123' }]],
    ['a branch name', [{ ok: true, title: 't', summary: 's', headSha: 'test' }]], ['an empty list', []], ['not a list', { ok: true, headSha: HEAD }],
    ['bad in the second entry (so nothing at all is posted)', [{ ok: true, title: 't', summary: 's', headSha: HEAD }, { ok: true, title: 't', summary: 's', headSha: 'x' }]]]) {
    fs.writeFileSync(verdictFile, JSON.stringify(content));
    gh = fakeApi();
    const core = await runPost(gh);
    ok(`post: a verdict whose head is ${label} posts nothing and fails the job`,
      !gh.calls.some((c) => c[0] === 'request') && core.out.failed.length === 1);
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.log(`not ok - the behaviour suite threw: ${error.stack}`); process.exit(1); });
