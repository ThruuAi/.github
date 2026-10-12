#!/usr/bin/env node
'use strict';

// governance/bootstrap.sh against a fake GitHub. A read-only stub `gh` first
// on PATH answers from fixtures, and records and refuses anything that would
// write. The script runs from a throwaway clone, and the canonical
// https://github.com/marvinamiranda/.github.git is a local bare repository
// (git's url.<local>.insteadOf), so its `test` branch is whatever a case says.
//
//   node governance/tests/bootstrap.test.js
//
// BOOTSTRAP_SCRIPT points it at another copy of bootstrap.sh, which is how a
// deliberately broken copy is shown to turn this suite red. BOOTSTRAP_BASH
// runs it under that bash (for example /bin/bash, macOS bash 3.2).

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { forgeCommitGraph } = require('./commit-graph-forge');
const { forgePackParent, forgeLooseObject, BACKDATED } = require('./object-forge');

const SCRIPT = process.env.BOOTSTRAP_SCRIPT
  ? path.resolve(process.env.BOOTSTRAP_SCRIPT)
  : path.join(__dirname, '..', 'bootstrap.sh');
// The provenance rule bootstrap.sh sources, beside it as in the repository.
const PROVENANCE = path.join(path.dirname(SCRIPT), 'identity', 'provenance.sh');
function withProvenance(governanceDir) {
  fs.mkdirSync(path.join(governanceDir, 'identity'), { recursive: true });
  fs.copyFileSync(PROVENANCE, path.join(governanceDir, 'identity', 'provenance.sh'));
}
// The PATH every child gets after its own directories: the absolute entries
// of this process's, since bootstrap.sh and create-app.py refuse an empty or
// relative entry (a developer's PATH can hold one, such as a literal ~/...).
const SYS_PATH = (process.env.PATH || '').split(':').filter((e) => e.startsWith('/')).join(':');
// An absolute path: a child's PATH may hold an empty entry here, and bash is not what is under test.
const BASH = process.env.BOOTSTRAP_BASH ? path.resolve(process.env.BOOTSTRAP_BASH)
  : spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
const ORG = 'marvinamiranda';
const CANONICAL = `https://github.com/${ORG}/.github.git`;
const REVIEWER_ID = 5075711;
const CHECKS_ID = 5105172;

let failed = 0;
let total = 0;
function ok(name, condition, detail = '') {
  total += 1;
  if (condition) console.log(`ok - ${name}`);
  else { failed += 1; console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
const stubBin = path.join(root, 'bin');
const fixtureFile = path.join(root, 'fixtures.json');
const ghLog = path.join(root, 'gh.log');
const cfg = path.join(root, 'cfg');
const reviewerJson = path.join(root, 'reviewer-app.json');
const checksJson = path.join(root, 'checks-app.json');
fs.mkdirSync(stubBin);
fs.mkdirSync(path.join(root, 'home'));
fs.mkdirSync(path.join(cfg, 'prod'), { recursive: true });
fs.writeFileSync(path.join(cfg, 'prod', 'areas.txt'), 'core|Everything in this test repository\n#   path: **\n');
fs.writeFileSync(path.join(cfg, 'prod', 'required-checks.txt'), 'build\nAll checks accounted for\n');
fs.writeFileSync(checksJson, JSON.stringify({ id: CHECKS_ID, slug: 'fake-checks' }));
fs.writeFileSync(reviewerJson, JSON.stringify({ id: REVIEWER_ID, slug: 'fake-reviewer' }));

// gh: `gh api [--paginate] <path> [--jq <expr>]` and `gh auth status` read
// fixtures; everything else, and any api call with a method or a body, is a
// write: recorded, and refused with exit 99.
fs.writeFileSync(path.join(stubBin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const log = (kind) => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ kind, args }) + '\\n');
const fixtures = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, 'utf8'));
if (args[0] === 'auth' && args[1] === 'status') {
  log('read');
  process.stderr.write("github.com\\n  - Token scopes: " + (process.env.FAKE_GH_SCOPES || "'admin:org', 'project', 'repo', 'workflow'") + "\\n");
  process.exit(0);
}
if (args[0] !== 'api') { log('write'); process.exit(99); }
// With FAKE_GH_WRITABLE=1, writes to a governance-checks environment and its
// deployment-branch policies succeed and change the fixtures, as GitHub would;
// every other write is still refused.
if (args.some((a) => ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^--(method|input|field|raw-field)=/.test(a))) {
  log('write');
  if (process.env.FAKE_GH_WRITABLE !== '1') process.exit(99);
  const method = args[args.indexOf('-X') + 1];
  const input = args.includes('--input') ? JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8')) : null;
  const p = args.slice(1).filter((a, i, all) => !a.startsWith('-') && !['-X', '--input'].includes(all[i - 1]))[0];
  const env = /^(repos[/][^/]+[/][^/]+[/]environments[/]governance-checks)$/.exec(p);
  const list = /^(repos[/][^/]+[/][^/]+[/]environments[/]governance-checks)[/]deployment-branch-policies(?:[/]([0-9]+))?$/.exec(p);
  const listKey = (e) => e + '/deployment-branch-policies?per_page=100';
  if (env && method === 'PUT') {
    fixtures[p] = { name: 'governance-checks', deployment_branch_policy: input.deployment_branch_policy };
    if (input.deployment_branch_policy && input.deployment_branch_policy.custom_branch_policies && !fixtures[listKey(p)]) fixtures[listKey(p)] = { total_count: 0, branch_policies: [] };
  } else if (list && method === 'POST' && !list[2]) {
    const l = fixtures[listKey(list[1])];
    const id = 1000 + l.branch_policies.length + Math.floor(Math.random() * 1000);
    l.branch_policies.push({ id, name: input.name, type: input.type });
    l.total_count = l.branch_policies.length;
  } else if (list && method === 'DELETE' && list[2]) {
    const l = fixtures[listKey(list[1])];
    l.branch_policies = l.branch_policies.filter((b) => String(b.id) !== list[2]);
    l.total_count = l.branch_policies.length;
  } else process.exit(99);
  fs.writeFileSync(process.env.FAKE_GH_FIXTURES, JSON.stringify(fixtures));
  process.stdout.write('{}\\n');
  process.exit(0);
}
let jq = null, target = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--jq') jq = args[++i];
  else if (a === '-H') i++;
  else if (a === '--paginate' || a === '--silent') {}
  else target = a;
}
log('read');
if (!(target in fixtures)) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
if (fixtures[target] && fixtures[target].__error) { process.stderr.write('gh: metadata unavailable (HTTP ' + fixtures[target].__error + ')\\n'); process.exit(1); }
if (args.includes('--paginate') && fixtures[target] && fixtures[target].__pages) { process.stdout.write(fixtures[target].__pages.map((p) => JSON.stringify(p)).join('\\n') + '\\n'); process.exit(0); }
const body = JSON.stringify(fixtures[target]);
process.stdout.write(jq ? execFileSync('jq', ['-r', jq], { input: body }) : body + '\\n');
`, { mode: 0o755 });

// git: the real one, except that the canonical URL of marvinamiranda/.github
// is served by the local bare repository named in bin/fake-github (a file,
// since the check reads test with \`env -i\`) after git's own URL
// rewriting: it asks the real git what the URL becomes under the caller's
// configuration (\`ls-remote --get-url\`) and uses that when an insteadOf
// rewrote it, as git would. provenance.sh reads test with a clean
// configuration, so "GitHub" cannot be reached through git configuration.
const REAL_GIT = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(path.join(stubBin, 'git'), `#!/usr/bin/env bash
real=${JSON.stringify(REAL_GIT)}
canonical=${JSON.stringify(CANONICAL)}
pre=()
if [ "\${1-}" = -C ]; then pre=(-C "$2"); fi
hit=0
for a in "$@"; do if [ "$a" = "$canonical" ]; then hit=1; fi; done
# Stands in for a system gitconfig (Homebrew's is writable by the owner's
# account): git reads it unless GIT_CONFIG_NOSYSTEM=1.
if [ -f ${JSON.stringify(path.join(stubBin, 'system-gitconfig'))} ]; then export GIT_CONFIG_SYSTEM=${JSON.stringify(path.join(stubBin, 'system-gitconfig'))}; fi
if [ $hit -eq 0 ]; then exec "$real" "$@"; fi
url="$("$real" \${pre[@]+"\${pre[@]}"} ls-remote --get-url "$canonical")"
if [ "$url" = "$canonical" ]; then url="$(cat ${JSON.stringify(path.join(stubBin, 'fake-github'))})"; fi
{ env | sed 's/=.*//' | sort | tr '\\n' ' '; echo "GIT_TERMINAL_PROMPT_VALUE=\${GIT_TERMINAL_PROMPT-unset}"; } >> ${JSON.stringify(path.join(stubBin, 'canonical-read-env.log'))}
args=()
for a in "$@"; do if [ "$a" = "$canonical" ]; then args+=("$url"); else args+=("$a"); fi; done
exec "$real" "\${args[@]}"
`, { mode: 0o755 });

function labelsFromScript() {
  // The standard labels, exactly as bootstrap.sh defines them, plus the area.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const labels = [];
  for (const m of src.matchAll(/^\s+"([^|"]+)\|([0-9a-f]{6})\|([^"]*)"$/gm)) labels.push({ name: m[1], color: m[2], description: m[3] });
  labels.push({ name: 'area:core', color: '1d76db', description: 'Everything in this test repository' });
  return labels;
}
function fixtures(extra = {}) {
  const repo = (name) => ({ name, full_name: `${ORG}/${name}`, default_branch: 'dev' });
  return {
    [`orgs/${ORG}/actions/secrets?per_page=100`]: { total_count: 0, secrets: [] },
    [`repos/${ORG}/prod/actions/secrets?per_page=100`]: { total_count: 0, secrets: [] },
    [`apps/marvinamiranda-checks`]: { id: CHECKS_ID, slug: 'marvinamiranda-checks' },
    [`repos/${ORG}/prod/pulls?state=all&base=test&sort=updated&direction=desc&per_page=20`]: [{ number: 17, updated_at: '2026-10-08T09:00:00Z', head: { sha: 'a'.repeat(40) } }],
    [`repos/${ORG}/prod/commits/${'a'.repeat(40)}/check-runs?per_page=100`]: { total_count: 2, check_runs: ['governance/issue-link', 'All checks accounted for'].map((name) => ({name, head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID }})) },
    [`user/1245936`]: { login: 'rodrigolmiranda', id: 1245936 },
    user: { login: 'rodrigolmiranda', id: 1245936 },
    [`orgs/${ORG}/issue-types`]: ['Task', 'Bug', 'Epic', 'Decision', 'Spike'].map((name, id) => ({ id, name, is_enabled: true })),
    [`repos/${ORG}/prod`]: repo('prod'),
    [`repos/${ORG}/prod/labels?per_page=100`]: labelsFromScript(),
    [`repos/${ORG}/prod/branches/dev`]: { name: 'dev', commit: { sha: '1'.repeat(40) } },
    [`repos/${ORG}/prod/branches/test`]: { name: 'test', commit: { sha: '1'.repeat(40) } },
    [`repos/${ORG}/.github/branches/test`]: { name: 'test', commit: { sha: '2'.repeat(40) } },
    [`repos/${ORG}/prod/rulesets?includes_parents=true&per_page=100`]: [],
    [`repos/${ORG}/.github/rulesets?includes_parents=true&per_page=100`]: [],
    ...environment('prod'),
    ...extra,
  };
}

// The governance-checks environment as the bootstrap leaves it: custom
// deployment branches, one rule, the default branch. `rules: null` leaves the
// environment out altogether.
const ENV_PATH = (repo) => `repos/${ORG}/${repo}/environments/governance-checks`;
const RULES_PATH = (repo) => `${ENV_PATH(repo)}/deployment-branch-policies?per_page=100`;
function environment(repo, { policy = { protected_branches: false, custom_branch_policies: true }, rules = [{ id: 1, name: 'dev', type: 'branch' }] } = {}) {
  if (rules === null) return { [ENV_PATH(repo)]: undefined, [RULES_PATH(repo)]: undefined };
  const out = { [ENV_PATH(repo)]: { name: 'governance-checks', deployment_branch_policy: policy } };
  if (policy && policy.custom_branch_policies) out[RULES_PATH(repo)] = { total_count: rules.length, branch_policies: rules };
  return out;
}

// A clone holding bootstrap.sh, and the canonical repository it is checked
// against. `on`: 'head' (test is this commit), 'ahead' (test has a later
// commit), 'elsewhere' (test is an unrelated commit), 'missing' (no canonical).
function checkout(on) {
  const dir = fs.mkdtempSync(path.join(root, 'co-'));
  const canon = path.join(dir, 'canon.git');
  const work = path.join(dir, 'work');
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'pipe' }).toString().trim();
  fs.mkdirSync(path.join(work, 'governance'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(work, 'governance', 'bootstrap.sh'));
  fs.chmodSync(path.join(work, 'governance', 'bootstrap.sh'), 0o755);
  withProvenance(path.join(work, 'governance'));
  git(root, 'init', '-q', work);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'bootstrap');
  if (on !== 'missing') {
    git(root, 'init', '-q', '--bare', canon);
    git(canon, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    if (on === 'head') git(work, 'push', '-q', canon, 'HEAD:refs/heads/test');
    if (on === 'ahead') {
      git(work, 'commit', '-q', '--allow-empty', '-m', 'later');
      git(work, 'push', '-q', canon, 'HEAD:refs/heads/test');
      git(work, 'reset', '-q', '--hard', 'HEAD~1');
    }
    if (on === 'elsewhere') {
      const branch = git(work, 'rev-parse', '--abbrev-ref', 'HEAD');
      git(work, 'checkout', '-q', '--orphan', 'other');
      git(work, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
      git(work, 'push', '-q', canon, 'HEAD:refs/heads/test');
      git(work, 'checkout', '-q', '-f', branch);
      git(work, 'branch', '-q', '-D', 'other');
    }
  }
  return { script: path.join(work, 'governance', 'bootstrap.sh'), canon, work };
}

// `repo: false` runs without the default `--repo prod --config-dir <cfg>`.
function bootstrap(args, { on = 'head', reviewer = true, checksApp = true, fx = fixtures(), where = null, repo = true, extraEnv = {}, writable = false, cwd = undefined } = {}) {
  const co = where || checkout(on);
  fs.writeFileSync(fixtureFile, JSON.stringify(fx));
  fs.writeFileSync(ghLog, '');
  fs.writeFileSync(path.join(stubBin, 'fake-github'), co.canon);
  const r = spawnSync(BASH, [co.script, ...(repo ? ['--repo', 'prod', '--config-dir', cfg] : []), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: [stubBin, SYS_PATH].join(':'),
      HOME: path.join(root, 'home'),
      TMPDIR: root,
      LANG: 'C',
      FAKE_GH_FIXTURES: fixtureFile,
      FAKE_GH_LOG: ghLog,
      FAKE_GH_WRITABLE: writable ? '1' : '0',
      MM_REVIEWER_APP_JSON: reviewer ? reviewerJson : path.join(root, 'no-such-reviewer.json'),
      MM_CHECKS_APP_JSON: checksApp ? checksJson : path.join(root, 'no-such-checks.json'),
      GIT_CONFIG_NOSYSTEM: '1',
      ...extraEnv,
    },
  });
  const calls = fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const state = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  return { ...r, calls, writes: calls.filter((c) => c.kind === 'write'), co, state };
}
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };
const tail = (r) => `exit ${r.status}; ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`;
const started = (r) => /== a\) Organisation issue types/.test(r.stdout);

// The ruleset payloads a dry run prints, by repository and name.
function planned(stdout) {
  const out = {};
  const re = /DRY-RUN would run: gh api -X (POST|PUT) repos\/[^/]+\/([^/\s]+)\/rulesets\S* --input - <<JSON\n([\s\S]*?)\n\s*JSON\n/g;
  for (const m of stdout.matchAll(re)) {
    try { const body = JSON.parse(m[3]); if (body.name) out[`${m[2]}/${body.name}`] = { method: m[1], body }; } catch (e) { /* not a ruleset body */ }
  }
  return out;
}
const pr = (rs) => (rs.rules.find((r) => r.type === 'pull_request') || {}).parameters || {};
const checks = (rs) => ((rs.rules.find((r) => r.type === 'required_status_checks') || {}).parameters || {}).required_status_checks || [];

// --------------------------- Checks App issuer pin and fail-closed preflight ----
if (process.env.BOOTSTRAP_DRIFT_ONLY !== '1') {
  const assertPins = (r, id) => {
    const plan = planned(r.stdout);
    for (const name of ['test-integration', 'main-checks']) {
      const rs = plan[`prod/${name}`];
      for (const context of ['governance/issue-link', 'All checks accounted for']) {
        ok(`${name}: ${context} is pinned to Checks App ${id}`, r.status === 0 && rs
          && checks(rs.body).some((c) => c.context === context && c.integration_id === id), tail(r));
      }
      ok(`${name}: all other issuers are unchanged`, rs && checks(rs.body).every((c) =>
        ['governance/issue-link', 'All checks accounted for'].includes(c.context)
          || c.integration_id === (c.context === 'review/independent' ? REVIEWER_ID : 15368)), tail(r));
    }
    ok('dev-integration retains Actions and Reviewer issuers', plan['prod/dev-integration']
      && checks(plan['prod/dev-integration'].body).every((c) =>
        c.integration_id === (c.context === 'review/independent' ? REVIEWER_ID : 15368)), tail(r));
  };
  assertPins(bootstrap(['--checks-app-id', String(CHECKS_ID)]), CHECKS_ID);
  assertPins(bootstrap([]), CHECKS_ID);
  fs.mkdirSync(path.join(cfg, 'prod2'));
  for (const file of ['areas.txt', 'required-checks.txt']) {
    fs.copyFileSync(path.join(cfg, 'prod', file), path.join(cfg, 'prod2', file));
  }
  const second = {};
  for (const [key, value] of Object.entries(fixtures())) {
    if (key.includes('/prod')) second[key.replace('/prod', '/prod2')] = value;
  }
  const multi = bootstrap(['--repo', 'prod2', '--checks-app-id', String(CHECKS_ID)], { fx: fixtures(second) });
  const multiPlan = planned(multi.stdout);
  ok('every --repo gets both Checks App pins in both migrated rulesets', multi.status === 0
    && ['prod', 'prod2'].every((repo) => ['test-integration', 'main-checks'].every((name) => {
      const rs = multiPlan[`${repo}/${name}`];
      return rs && ['governance/issue-link', 'All checks accounted for'].every((context) =>
        checks(rs.body).some((c) => c.context === context && c.integration_id === CHECKS_ID));
    })), tail(multi));

  for (const args of [[], ['--apply']]) {
    const r = bootstrap(args, { checksApp: false });
    ok(`missing Checks App refuses ${args.includes('--apply') ? 'apply' : 'dry run'} before any ruleset write`,
      r.status !== 0 && /--checks-app-id/.test(r.stderr) && r.writes.length === 0
        && Object.keys(planned(r.stdout)).length === 0, tail(r));
  }
  let r = bootstrap(['--no-rulesets'], { checksApp: false });
  ok('no-rulesets requires no Checks App', r.status === 0 && r.writes.length === 0, tail(r));
  for (const value of ['abc', '-1', '1.5', '', '0', '0015368']) {
    r = bootstrap(['--checks-app-id', value]);
    ok(`Checks App rejects nonnumeric id ${JSON.stringify(value)}`, r.status === 2
      && /--checks-app-id needs a numeric id/.test(r.stderr) && r.calls.length === 0, tail(r));
  }
  r = bootstrap(['--checks-app-id']);
  ok('Checks App rejects missing argument', r.status === 2 && /numeric id/.test(r.stderr), tail(r));
  const invalidJson = path.join(root, 'invalid-checks.json');
  fs.writeFileSync(invalidJson, JSON.stringify({ id: 'not-an-id' }));
  r = bootstrap([], { extraEnv: { MM_CHECKS_APP_JSON: invalidJson } });
  ok('invalid app.json id fails closed', r.status !== 0 && /--checks-app-id/.test(r.stderr)
    && r.writes.length === 0, tail(r));
  for (const value of ['0', '0015368', String(REVIEWER_ID), '15368', '123']) {
    const refusal = bootstrap(['--checks-app-id', value, '--apply']);
    ok(`Checks App refuses unsafe issuer ${value} before writes`, refusal.status !== 0 && refusal.writes.length === 0 && (![String(REVIEWER_ID), '15368'].includes(value) || /differ from Reviewer and Actions/.test(refusal.stderr)), tail(refusal));
    const badFile = path.join(root, `checks-${value}.json`);
    fs.writeFileSync(badFile, JSON.stringify({ id: value }));
    const fallback = bootstrap(['--apply'], { extraEnv: { MM_CHECKS_APP_JSON: badFile } });
    ok(`Checks App fallback refuses unsafe issuer ${value} before writes`, fallback.status !== 0 && fallback.writes.length === 0, tail(fallback));
  }
  const runsKey = `repos/${ORG}/prod/commits/${'a'.repeat(40)}/check-runs?per_page=100`;
  for (const omitted of ['governance/issue-link', 'All checks accounted for']) {
    const fx = fixtures({ [runsKey]: { check_runs: [{ name: omitted === 'governance/issue-link' ? 'All checks accounted for' : 'governance/issue-link', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } }] } });
    const refused = bootstrap(['--apply'], { fx });
    ok(`missing ${omitted} publisher refuses apply before ANY writes`, refused.status !== 0 && refused.writes.length === 0 && /publisher/.test(refused.stderr), tail(refused));
    const warned = bootstrap([], { fx });
    ok(`missing ${omitted} publisher warns dry run`, warned.status === 0 && /WARNING: .*publisher/.test(warned.stdout), tail(warned));
  }
  for (const [label, fx] of [
    ['shadow name on the right head', fixtures({ [runsKey]: { check_runs: [{ name: 'All checks accounted for (Checks App shadow)', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } }, { name: 'governance/issue-link', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } }] } })],
    ['Actions aggregate on the right head', fixtures({ [runsKey]: { check_runs: [{ name: 'All checks accounted for', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: 15368 } }, { name: 'governance/issue-link', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } }] } })],
    ['no recent PR', fixtures({ [`repos/${ORG}/prod/pulls?state=all&base=test&sort=updated&direction=desc&per_page=20`]: [] })],
    ['unreadable check runs', fixtures({ [runsKey]: null })],
  ]) {
    const refused = bootstrap(['--apply'], { fx });
    ok(`${label} refuses apply before writes`, refused.status !== 0 && refused.writes.length === 0, tail(refused));
  }
  for (const conclusion of ['failure', 'neutral', 'cancelled', null]) {
    const fx = fixtures({ [runsKey]: { check_runs: [
      { name: 'governance/issue-link', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } },
      { name: 'All checks accounted for', head_sha: 'a'.repeat(40), conclusion, app: { id: CHECKS_ID } },
    ] } });
    const refused = bootstrap(['--apply'], { fx });
    ok(`aggregate ${conclusion} cannot prove successful publisher`, refused.status !== 0 && refused.writes.length === 0, tail(refused));
  }
  r = bootstrap([]);
  ok('publisher proof prints PR number, exact head and updated_at', r.status === 0
    && r.stdout.includes(`PR #17 head ${'a'.repeat(40)} updated_at 2026-10-08T09:00:00Z`), tail(r));
  r = bootstrap([], { fx: fixtures({ [runsKey]: { __pages: [
    { check_runs: [{ name: 'governance/issue-link', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } }] },
    { check_runs: [{ name: 'All checks accounted for', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } }] },
  ] } }) });
  ok('publisher proof reads all check-run pages on one head', r.status === 0 && /publisher proven/.test(r.stdout) && !/publisher.*not proven/.test(r.stdout), tail(r));
  const recentKey = `repos/${ORG}/prod/pulls?state=all&base=test&sort=updated&direction=desc&per_page=20`;
  const split = fixtures({
    [recentKey]: [{ head: { sha: 'a'.repeat(40) } }, { head: { sha: 'b'.repeat(40) } }],
    [runsKey]: { check_runs: [{ name: 'governance/issue-link', head_sha: 'a'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } }] },
    [`repos/${ORG}/prod/commits/${'b'.repeat(40)}/check-runs?per_page=100`]: { check_runs: [{ name: 'All checks accounted for', head_sha: 'b'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } }] },
  });
  r = bootstrap(['--apply'], { fx: split });
  ok('contexts split across PR heads cannot qualify', r.status !== 0 && r.writes.length === 0, tail(r));
  r = bootstrap(['--apply'], { fx: fixtures({ [runsKey]: { check_runs: ['governance/issue-link', 'All checks accounted for'].map((name) => ({ name, head_sha: 'b'.repeat(40), conclusion: 'success', app: { id: CHECKS_ID } })) } }) });
  ok('wrong check-run head cannot qualify', r.status !== 0 && r.writes.length === 0, tail(r));
  r = bootstrap(['--apply'], { fx: fixtures({ 'apps/marvinamiranda-checks': { id: 42 } }) });
  ok('public App metadata mismatch refuses before writes', r.status !== 0 && r.writes.length === 0, tail(r));
  r = bootstrap(['--repo', 'prod2', '--apply'], { fx: fixtures({ ...second, [`repos/${ORG}/prod2/pulls?state=all&base=test&sort=updated&direction=desc&per_page=20`]: [] }) });
  ok('later repo missing probe blocks every repo mutation', r.status !== 0 && r.writes.length === 0, tail(r));
  r = bootstrap([]);
  ok('preflight prints verified Checks App identity and publisher proof', r.status === 0 && /Checks App id: 5105172 \(marvinamiranda-checks\)/.test(r.stdout) && /publisher.*prod/.test(r.stdout), tail(r));
  const co = checkout('head');
  const self = bootstrap(['--self-only'], { repo: false, where: co, checksApp: false });
  const supplied = bootstrap(['--self-only', '--checks-app-id', '123'], { repo: false, where: co });
  ok('self-only output is byte-identical regardless of Checks App presence', self.status === 0
    && supplied.status === 0 && self.stdout === supplied.stdout, tail(self));
  ok('self-only full output matches pre-change baseline (generated commit IDs normalised)', require('crypto').createHash('sha256')
    .update(self.stdout.replace(/[a-f0-9]{40}/g, '<commit>').replace(/read now: [a-f0-9]{12}/g, 'read now: <short>')).digest('hex') === '8d14618b821f9c21f5671fc773c32540269983b013b4b83176f016c245ba82a1');
}

// ----------------------------------------- --org: a repository transferred to ThruuAi ----
// The rulesets are re-asserted against the new owner. Nothing in marvinamiranda
// is read or written (this repository's own rulesets included), --self-only is
// refused, and the Checks App proof counts only check runs completed at or
// after the transfer: a head from before it carries the old organisation's runs.
if (process.env.BOOTSTRAP_DRIFT_ONLY !== '1') {
  const THRUU = 'ThruuAi';
  const SINCE = '2026-10-12T15:00:00Z';
  const thruu = (completedAt, extra = {}) => {
    const out = {};
    for (const [k, v] of Object.entries(fixtures())) {
      if (k.includes('/.github/')) continue;
      out[k.replace(`repos/${ORG}/`, `repos/${THRUU}/`).replace(`orgs/${ORG}/`, `orgs/${THRUU}/`)] = v;
    }
    out[`repos/${THRUU}/prod/commits/${'a'.repeat(40)}/check-runs?per_page=100`] = { total_count: 2, check_runs:
      ['governance/issue-link', 'All checks accounted for'].map((name) => ({ name, head_sha: 'a'.repeat(40), conclusion: 'success', completed_at: completedAt, app: { id: CHECKS_ID } })) };
    return { ...out, ...extra };
  };
  const inHome = (r) => r.calls.filter((c) => c.args.some((a) => a.includes(`repos/${ORG}/`) || a.includes(`orgs/${ORG}/`)));
  let t = bootstrap(['--org', THRUU, '--checks-since', SINCE], { fx: thruu('2026-10-12T15:30:00Z') });
  const plan = planned(t.stdout);
  ok('--org ThruuAi: dry run plans prod rulesets in ThruuAi', t.status === 0 && plan['prod/test-integration'] && plan['prod/main-owner-only'], tail(t));
  ok('--org ThruuAi: review/independent stays pinned to the Reviewer App', plan['prod/test-integration']
    && checks(plan['prod/test-integration'].body).some((c) => c.context === 'review/independent' && c.integration_id === REVIEWER_ID), tail(t));
  ok('--org ThruuAi: this repository\'s own rulesets are not planned', !Object.keys(plan).some((k) => k.startsWith('.github/')), Object.keys(plan).join(','));
  ok('--org ThruuAi: nothing in marvinamiranda is read', inHome(t).length === 0, JSON.stringify(inHome(t).slice(0, 2)));
  ok('--org ThruuAi: the ruleset writes target ThruuAi', /gh api -X POST repos\/ThruuAi\/prod\/rulesets/.test(t.stdout), tail(t));
  ok('--org ThruuAi: a post-transfer Checks App run proves the publisher', /publisher proven for prod/.test(t.stdout), tail(t));
  t = bootstrap(['--org', THRUU, '--checks-since', SINCE, '--apply'], { fx: thruu('2026-10-12T14:59:59Z') });
  ok('--org ThruuAi: a Checks App run from before the transfer refuses --apply before any write', t.status !== 0 && t.writes.length === 0 && /publisher/.test(t.stderr), tail(t));
  t = bootstrap(['--org', THRUU, '--checks-since', SINCE, '--apply'], { fx: thruu(undefined) });
  ok('--org ThruuAi: a Checks App run without completed_at cannot qualify', t.status !== 0 && t.writes.length === 0, tail(t));
  t = bootstrap(['--org', THRUU, '--apply'], { fx: thruu('2026-10-12T15:30:00Z') });
  ok('--org ThruuAi: rulesets without --checks-since exit 2 before any call', t.status === 2 && t.calls.length === 0 && /--checks-since/.test(t.stderr), tail(t));
  t = bootstrap(['--org', THRUU, '--no-rulesets'], { fx: thruu('2026-10-12T15:30:00Z') });
  ok('--org ThruuAi --no-rulesets needs no --checks-since', t.status === 0 && inHome(t).length === 0, tail(t));
  t = bootstrap(['--org', THRUU, '--self-only'], { repo: false });
  ok('--org ThruuAi --self-only exits 2 before any call', t.status === 2 && t.calls.length === 0, tail(t));
  for (const bad of ['thruuai-evil', 'marvinamiranda2', '']) {
    t = bootstrap(['--org', bad, '--no-rulesets']);
    ok(`--org ${JSON.stringify(bad)} outside the allow-list exits 2 before any call`, t.status === 2 && t.calls.length === 0, tail(t));
  }
  t = bootstrap(['--org', THRUU, '--checks-since', '2026-10-12 15:00']);
  ok('--checks-since that is not ISO 8601 UTC exits 2', t.status === 2 && t.calls.length === 0, tail(t));
}

// Step g only inspects secret NAME metadata; never reads or changes key values.
{
  const repoKey = `repos/${ORG}/prod/actions/secrets?per_page=100`;
  const orgKey = `orgs/${ORG}/actions/secrets?per_page=100`;
  const key = { name: 'CHECKS_APP_PRIVATE_KEY' };
  for (const [scope, endpoint] of [['repository', repoKey], ['organization', orgKey]]) {
    const r = bootstrap(['--no-rulesets'], { fx: fixtures({ [endpoint]: { total_count: 1, secrets: [key] } }) });
    ok(`${scope} key placement is drift, never automatically mutated`, r.status === 0
      && r.stdout.includes(`DRIFT: ${scope}`) && r.stdout.includes('CHECKS_APP_PRIVATE_KEY')
      && r.writes.length === 0 && !/governance-checks: up to date/.test(r.stdout), tail(r));
    const paged = bootstrap(['--no-rulesets'], { fx: fixtures({ [endpoint]: { __pages: [
      { total_count: 2, secrets: [{ name: 'OTHER' }] }, { total_count: 2, secrets: [key] },
    ] } }) });
    ok(`${scope} key drift on a later metadata page is found`, paged.status === 0 && paged.stdout.includes(`DRIFT: ${scope}`), tail(paged));
    for (const [label, body] of [['forbidden', { __error: 403 }], ['not found', { __error: 404 }],
      ['malformed', { total_count: 0, secrets: null }], ['truncated', { total_count: 1, secrets: [] }]]) {
      const r = bootstrap(['--no-rulesets'], { fx: fixtures({ [endpoint]: body }) });
      ok(`${scope} ${label} metadata is unverified, not absent`, r.status === 0
        && r.stdout.includes(`UNVERIFIED: ${scope}`) && !/governance-checks: up to date/.test(r.stdout)
        && r.writes.length === 0, tail(r));
    }
  }
  const r = bootstrap(['--no-rulesets']);
  ok('successful empty repo/org metadata allows environment up-to-date', r.status === 0 && /governance-checks: up to date/.test(r.stdout), tail(r));
  const self = bootstrap(['--self-only'], { repo: false });
  ok('self-only never queries secret metadata', self.status === 0 && !self.calls.some((c) => c.args.some((a) => a.includes('/actions/secrets'))), tail(self));
}

// Focused issuer-contract suite for causal mutations; exercises the same CLI cases.
if (process.env.BOOTSTRAP_CHECKS_ONLY === '1' || process.env.BOOTSTRAP_DRIFT_ONLY === '1') {
  console.log(`${total - failed}/${total} passed`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------ N6: the Reviewer App id ----
{
  let r = bootstrap([], { reviewer: false });
  ok('without a Reviewer App id, a run with rulesets aborts before it reads or plans anything',
    r.status !== 0 && /Reviewer App/.test(r.stderr) && !started(r) && r.calls.length === 0, tail(r));
  r = bootstrap(['--apply'], { reviewer: false });
  ok('...and so does --apply, before any write', r.status !== 0 && /Reviewer App/.test(r.stderr) && r.writes.length === 0 && !started(r), tail(r));
  r = bootstrap(['--no-rulesets'], { reviewer: false });
  ok('without a Reviewer App id, --no-rulesets still runs (no ruleset needs it)',
    r.status === 0 && /0 change\(s\) planned/.test(r.stdout), tail(r));
}

// ------------------------------------ N2: --apply only from a commit on test ----
{
  let r = bootstrap(['--no-rulesets', '--apply'], { on: 'elsewhere' });
  ok('--apply refuses a commit that is not on test as fetched now, before any gh call',
    r.status !== 0 && /Refusing --apply/.test(r.stderr) && /not on marvinamiranda\/\.github test/.test(r.stderr) && r.calls.length === 0, tail(r));
  r = bootstrap(['--no-rulesets', '--apply'], { on: 'head' });
  ok('--apply runs from the commit test points at', r.status === 0 && /0 change\(s\) applied/.test(r.stdout) && r.writes.length === 0, tail(r));
  r = bootstrap(['--no-rulesets', '--apply'], { on: 'ahead' });
  ok('--apply runs from an older commit of test', r.status === 0 && /0 change\(s\) applied/.test(r.stdout), tail(r));
  r = bootstrap(['--no-rulesets'], { on: 'elsewhere' });
  ok('a dry run from a commit not on test warns and carries on',
    r.status === 0 && /WARNING: .*not on marvinamiranda\/\.github test.*--apply would refuse/.test(r.stdout), tail(r));
  r = bootstrap(['--no-rulesets', '--apply'], { on: 'missing' });
  ok('--apply refuses when test cannot be read', r.status !== 0 && /Refusing --apply/.test(r.stderr) && r.calls.length === 0, tail(r));

  const co = checkout('head');
  fs.appendFileSync(co.script, '# a local edit\n');
  r = bootstrap(['--no-rulesets', '--apply'], { where: co });
  ok('--apply refuses a checkout with uncommitted changes', r.status !== 0 && /uncommitted/.test(r.stderr) && r.calls.length === 0, tail(r));

  // A redirect of the canonical URL to a repository whose test is this
  // unmerged commit: ignored, because test is read with a clean configuration.
  const planted = checkout('elsewhere');
  const evil = path.join(root, `evil-${path.basename(path.dirname(planted.work))}.git`);
  execFileSync('git', ['init', '-q', '--bare', evil]);
  execFileSync('git', ['-C', planted.work, 'push', '-q', evil, 'HEAD:refs/heads/test']);
  fs.writeFileSync(path.join(stubBin, 'fake-github'), planted.canon);
  const control = spawnSync('git', ['ls-remote', CANONICAL, 'refs/heads/test'], { encoding: 'utf8', env: { PATH: [stubBin, SYS_PATH].join(':'),
    HOME: path.join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${evil}.insteadOf`, GIT_CONFIG_VALUE_0: CANONICAL } });
  ok('control: a planted insteadOf does redirect the canonical URL for an ordinary git call',
    control.stdout.startsWith(execFileSync('git', ['-C', planted.work, 'rev-parse', 'HEAD']).toString().trim()), control.stdout + control.stderr);
  const homeConfig = path.join(root, 'home', '.gitconfig');
  for (const [what, extraEnv, setup, undo] of [
    ['GIT_CONFIG_COUNT in the environment', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${evil}.insteadOf`, GIT_CONFIG_VALUE_0: CANONICAL }],
    ['GIT_CONFIG_PARAMETERS in the environment', { GIT_CONFIG_PARAMETERS: `'url.${evil}.insteadof'='${CANONICAL}'` }],
    ['the global ~/.gitconfig', {}, () => fs.writeFileSync(homeConfig, `[url "${evil}"]\n\tinsteadOf = ${CANONICAL}\n`), () => fs.rmSync(homeConfig, { force: true })],
    ['the checkout\'s own .git/config', {}, () => execFileSync('git', ['-C', planted.work, 'config', `url.${evil}.insteadOf`, CANONICAL]),
      () => execFileSync('git', ['-C', planted.work, 'config', '--unset', `url.${evil}.insteadOf`])],
  ]) {
    if (setup) setup();
    r = bootstrap(['--no-rulesets', '--apply'], { where: planted, extraEnv });
    if (undo) undo();
    ok(`--apply ignores an insteadOf in ${what} pointing test at the unmerged commit it runs from: refused, before any gh call`,
      r.status !== 0 && /not on marvinamiranda\/\.github test/.test(r.stderr) && r.calls.length === 0, tail(r));
  }

  // An edit hidden from git status is still an edit.
  const skip = checkout('head');
  execFileSync('git', ['-C', skip.work, 'update-index', '--skip-worktree', 'governance/bootstrap.sh']);
  fs.appendFileSync(skip.script, '# hidden\n');
  r = bootstrap(['--no-rulesets', '--apply'], { where: skip });
  ok('--apply refuses an edit hidden with skip-worktree', r.status !== 0 && /differs from its commit/.test(r.stderr) && r.calls.length === 0, tail(r));

  const untracked = checkout('head');
  fs.writeFileSync(path.join(untracked.work, 'governance', 'planted.sh'), 'echo planted\n');
  r = bootstrap(['--no-rulesets', '--apply'], { where: untracked });
  ok('--apply refuses an untracked file under governance/', r.status !== 0 && /uncommitted/.test(r.stderr) && r.calls.length === 0, tail(r));

  const hushed = checkout('head');
  execFileSync('git', ['-C', hushed.work, 'config', 'status.showUntrackedFiles', 'no']);
  fs.writeFileSync(path.join(hushed.work, 'governance', 'planted.sh'), 'echo planted\n');
  r = bootstrap(['--no-rulesets', '--apply'], { where: hushed });
  ok('--apply refuses an untracked file even with status.showUntrackedFiles=no', r.status !== 0 && /uncommitted/.test(r.stderr) && r.calls.length === 0, tail(r));

  // Replace refs and grafts: test's commit made to "descend" from an unmerged one.
  const gitIn = (co, ...a) => execFileSync('git', ['-C', co.work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]).toString().trim();
  for (const [what, plantIt] of [
    ['a replace ref', (co, merged, local) => gitIn(co, 'replace', '--graft', merged, local)],
    ['a .git/info/grafts entry', (co, merged, local) => { fs.mkdirSync(path.join(co.work, '.git', 'info'), { recursive: true }); fs.writeFileSync(path.join(co.work, '.git', 'info', 'grafts'), `${merged} ${local}\n`); }],
  ]) {
    const co = checkout('head');
    const merged = gitIn(co, 'rev-parse', 'HEAD');
    gitIn(co, 'commit', '-q', '--allow-empty', '-m', 'local, not on test');
    plantIt(co, merged, gitIn(co, 'rev-parse', 'HEAD'));
    r = bootstrap(['--no-rulesets', '--apply'], { where: co });
    ok(`--apply ignores ${what} grafting test onto the unmerged commit it runs from: refused, before any gh call`,
      r.status !== 0 && /not on marvinamiranda\/\.github test/.test(r.stderr) && r.calls.length === 0, tail(r));
  }

  // A forged commit-graph: the parent A of test's tip T made to list the
  // unmerged HEAD U as its only parent. Not T itself: merge-base parses the two
  // commits it is given from their objects, and every commit it walks to (A)
  // from the graph.
  {
    const co = checkout('head');
    const parent = gitIn(co, 'rev-parse', 'HEAD');
    gitIn(co, 'commit', '-q', '--allow-empty', '-m', 'merged');
    gitIn(co, 'push', '-q', co.canon, 'HEAD:refs/heads/test');
    const tip = gitIn(co, 'rev-parse', 'HEAD');
    gitIn(co, 'commit', '-q', '--allow-empty', '-m', 'local, not on test');
    const unmerged = gitIn(co, 'rev-parse', 'HEAD');
    forgeCommitGraph(co.work, parent, { parent: unmerged });
    const fooled = spawnSync('git', ['-C', co.work, 'merge-base', '--is-ancestor', unmerged, tip]).status === 0;
    ok('control: the forged commit-graph makes plain git believe the unmerged commit is on test', fooled, '');
    r = bootstrap(['--no-rulesets', '--apply'], { where: co });
    ok('--apply ignores a forged commit-graph making test descend from the unmerged commit it runs from: refused, before any gh call',
      r.status !== 0 && /not on marvinamiranda\/\.github test/.test(r.stderr) && r.calls.length === 0, tail(r));
  }

  // marvinamiranda/.github#26: a process that can write under the checkout's
  // .git. Nothing there may run (bootstrap.sh sources provenance.sh in the
  // shell that holds the owner's token), and none of its objects may decide.
  {
    const TOKEN = 'github_pat_FAKEOWNERTOKEN';
    for (const [what, plantIt, control] of [
      ['a core.fsmonitor hook', (co, hook) => gitIn(co, 'config', 'core.fsmonitor', hook),
        (co) => spawnSync('git', ['-C', co.work, 'status', '--porcelain'], { env: { ...process.env, GH_TOKEN: TOKEN } })],
      ['a clean filter on every path', (co, hook) => {
        gitIn(co, 'config', 'filter.mm.clean', `${hook}; cat`);
        fs.mkdirSync(path.join(co.work, '.git', 'info'), { recursive: true });
        fs.writeFileSync(path.join(co.work, '.git', 'info', 'attributes'), '* filter=mm\n');
      }, (co) => spawnSync('git', ['-C', co.work, 'hash-object', '--', 'governance/bootstrap.sh'], { env: { ...process.env, GH_TOKEN: TOKEN } })],
    ]) {
      const co = checkout('head');
      const ran = path.join(path.dirname(co.work), 'ran.log');
      const hook = path.join(path.dirname(co.work), 'hook.sh');
      fs.writeFileSync(hook, `#!/bin/sh\necho "token=\${GH_TOKEN-unset}" >> ${JSON.stringify(ran)}\n`, { mode: 0o755 });
      plantIt(co, hook);
      control(co);
      const fired = readLines(ran).some((l) => l === `token=${TOKEN}`);
      fs.rmSync(ran, { force: true });
      ok(`control: ${what} in the checkout's own config runs for plain git, with the caller's token`, fired, '');
      r = bootstrap(['--no-rulesets', '--apply'], { where: co, extraEnv: { GH_TOKEN: TOKEN } });
      ok(`--apply never runs ${what} from the checkout's own config: it runs, and the hook never did`,
        r.status === 0 && /0 change\(s\) applied/.test(r.stdout) && !fs.existsSync(ran), `${tail(r)} ran=${readLines(ran).join(',')}`);
    }

    // A replaced pack whose index files a forged parent of test's tip, listing
    // the unmerged HEAD as its parent: plain git then walks from test to HEAD.
    const co = checkout('head');
    const parent = gitIn(co, 'rev-parse', 'HEAD');
    gitIn(co, 'commit', '-q', '--allow-empty', '-m', 'merged');
    gitIn(co, 'push', '-q', co.canon, 'HEAD:refs/heads/test');
    const tip = gitIn(co, 'rev-parse', 'HEAD');
    // Dated before test's tip: git 2.55 stops an ancestry walk at commits
    // older than the one it looks for, and the writer chooses this date.
    execFileSync('git', ['-C', co.work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'local, not on test'],
      { env: { ...process.env, ...BACKDATED } });
    const unmerged = gitIn(co, 'rev-parse', 'HEAD');
    forgePackParent(co.work, parent, unmerged);
    const fooled = spawnSync('git', ['-C', co.work, '-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', unmerged, tip],
      { env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } }).status === 0;
    ok('control: the replaced pack makes plain git believe the unmerged commit is on test', fooled, '');
    r = bootstrap(['--no-rulesets', '--apply'], { where: co });
    ok('--apply ignores a replaced pack making test descend from the unmerged commit it runs from: refused, before any gh call',
      r.status !== 0 && /not on marvinamiranda\/\.github test/.test(r.stderr) && r.calls.length === 0, tail(r));

    // A forged tree object: HEAD's governance/ tree filed as one listing an
    // edited bootstrap.sh, with the index agreeing, so git status is clean and
    // plain git reads the edit as committed.
    const forged = checkout('head');
    const sub = gitIn(forged, 'rev-parse', 'HEAD:governance');
    fs.appendFileSync(forged.script, '# edited, not committed\n');
    gitIn(forged, 'add', 'governance/bootstrap.sh');
    const evilSub = gitIn(forged, 'write-tree', '--prefix=governance/');
    const raw = execFileSync('git', ['-C', forged.work, 'cat-file', 'tree', evilSub]);
    forgeLooseObject(forged.work, sub, 'tree', raw);
    const treeFooled = gitIn(forged, 'status', '--porcelain') === ''
      && gitIn(forged, 'rev-parse', 'HEAD:governance/bootstrap.sh') === gitIn(forged, 'hash-object', 'governance/bootstrap.sh');
    ok('control: the forged tree makes plain git read the edited bootstrap.sh as committed, with git status clean', treeFooled, '');
    r = bootstrap(['--no-rulesets', '--apply'], { where: forged });
    ok('--apply ignores a forged tree object dressing an edited bootstrap.sh as committed: refused, before any gh call',
      r.status !== 0 && /bootstrap\.sh differs from its commit/.test(r.stderr) && r.calls.length === 0, tail(r));
  }

  // Nothing the checkout holds may run through a PATH lookup either
  // (miranda-infrastructure#616 review): bootstrap.sh sources provenance.sh in
  // the shell that exports the owner's token, and a PATH with an empty entry
  // (":$PATH", from an unset variable) or an entry inside the checkout finds
  // whatever the checkout holds under a command's name. The sourced rule runs
  // with every name it or its older copy uses planted as an executable that
  // records the token, in the checked directory, and then at the checkout's root.
  {
    const PLANTED = ['find', 'awk', 'sed', 'grep', 'head', 'tr', 'readlink', 'dirname', 'env', 'git', 'cat', 'mktemp', 'perl', 'rm', 'cut', 'sort'];
    const REAL_BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
    const TOKEN = 'github_pat_FAKEOWNERTOKEN';
    for (const [what, where, expect, alias] of [
      ['in the checked directory, with an empty PATH entry and that directory on PATH', ['governance', 'governance/identity'], /is not in its commit/],
      ['at the checkout\'s root, with an empty PATH entry, the root on PATH, and the root as the working directory', ['.'], null],
      ['at the checkout\'s root, with the root on PATH under another letter case', ['.'], null, (w) => w.toUpperCase()],
      ['at the checkout\'s root, with the root on PATH through the /System/Volumes/Data firmlink', ['.'], null, (w) => `/System/Volumes/Data${fs.realpathSync(w)}`],
    ]) {
      const co = checkout('head');
      if (alias && !fs.existsSync(alias(co.work))) {
        console.log(`ok - # SKIP planted ${what}: no such alias on this filesystem`);
        continue;
      }
      const ran = path.join(path.dirname(co.work), 'planted-ran.log');
      for (const d of where) {
        for (const n of PLANTED) {
          fs.writeFileSync(path.join(co.work, d, n), `#!/bin/sh\necho "${n} token=\${GH_TOKEN-unset}" >> ${JSON.stringify(ran)}\nexit 1\n`, { mode: 0o755 });
        }
      }
      fs.writeFileSync(path.join(stubBin, 'fake-github'), co.canon);
      const onPath = alias ? [alias(co.work)] : ['', ...where.map((d) => path.join(co.work, d))];
      const x = spawnSync(REAL_BASH, ['-c', '. "$1"; mm_provenance "$2" "$3"; printf "PROBLEM=%s\\n" "$PROVENANCE_PROBLEM"',
        '_', PROVENANCE, path.join(co.work, 'governance'), fs.mkdtempSync(path.join(root, 'sourced-'))], {
        cwd: co.work, encoding: 'utf8',
        env: { PATH: [...onPath, stubBin, SYS_PATH].join(':'), HOME: path.join(root, 'home'), GH_TOKEN: TOKEN, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' },
      });
      const problem = (/^PROBLEM=(.*)$/m.exec(x.stdout) || [])[1];
      ok(`nothing planted ${what} runs while the sourced rule decides, and the token reaches none of it`,
        readLines(ran).length === 0 && problem !== undefined && (expect ? expect.test(problem) : problem === ''),
        `ran=${readLines(ran).join(',')} problem=${problem} ${x.stderr.trim().split('\n').slice(-1)}`);
    }
  }

  // The entry point itself (review of #27 at 8a9fd87): bootstrap.sh holds the
  // owner's token for its whole run, so it refuses a PATH that could find a
  // command in the checkout before it runs any command at all: an empty or a
  // relative entry, or the checkout under any spelling. Planted at the
  // checkout's root, which no content check covers, and run from there.
  {
    const TOKEN = 'github_pat_FAKEOWNERTOKEN';
    const PLANTED = ['gh', 'jq', 'mktemp', 'awk', 'dirname', 'cat', 'rm', 'git', 'env', 'sed', 'grep', 'find', 'perl', 'tr', 'head'];
    const co = checkout('head');
    const ran = path.join(path.dirname(co.work), 'entry-ran.log');
    for (const n of PLANTED) {
      fs.writeFileSync(path.join(co.work, n), `#!/bin/sh\necho "${n} token=\${GH_TOKEN-unset}" >> ${JSON.stringify(ran)}\nexit 1\n`, { mode: 0o755 });
    }
    const upper = co.work.toUpperCase();
    const firm = `/System/Volumes/Data${fs.realpathSync(co.work)}`;
    const shapes = [['an empty entry', ''], ['a relative entry', 'governance'], ['the checkout itself', co.work],
      ['the checkout under another letter case', upper], ['the checkout through the /System/Volumes/Data firmlink', firm]];
    for (const [what, entry] of shapes) {
      if (entry.startsWith('/') && entry !== co.work && !fs.existsSync(entry)) {
        console.log(`ok - # SKIP ${what}: no such alias on this filesystem`);
        continue;
      }
      fs.rmSync(ran, { force: true });
      r = bootstrap(['--no-rulesets', '--apply'], { where: co, cwd: co.work, extraEnv: { GH_TOKEN: TOKEN, PATH: [entry, stubBin, SYS_PATH].join(':') } });
      ok(`bootstrap.sh refuses a PATH with ${what} before running anything: nothing planted at the checkout's root runs, no gh call`,
        r.status !== 0 && /Refusing: PATH/.test(r.stderr) && readLines(ran).length === 0 && r.calls.length === 0,
        `${tail(r)} ran=${readLines(ran).join(',')}`);
    }
    fs.rmSync(ran, { force: true });
    r = bootstrap(['--no-rulesets', '--apply'], { where: co, cwd: co.work, extraEnv: { GH_TOKEN: TOKEN } });
    ok('with a clean PATH, run from the checkout\'s root, bootstrap.sh --apply completes and nothing planted there runs',
      r.status === 0 && /0 change\(s\) applied/.test(r.stdout) && readLines(ran).length === 0, `${tail(r)} ran=${readLines(ran).join(',')}`);
  }

  // test is read with nothing from the environment but PATH.
  const envLog = path.join(stubBin, 'canonical-read-env.log');
  fs.writeFileSync(envLog, '');
  const leaky = { HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: '/nonexistent/ca.pem',
    SSL_CERT_DIR: '/nonexistent', CURL_CA_BUNDLE: '/nonexistent/ca.pem', GIT_SSL_NO_VERIFY: '1', MM_UNLISTED_PROBE: 'x',
    GH_TOKEN: 'github_pat_LEAKPROBE', GITHUB_TOKEN: 'github_pat_LEAKPROBE2' };
  r = bootstrap(['--no-rulesets'], { extraEnv: leaky });
  const seen = readLines(envLog);
  const leaked = seen.flatMap((line) => Object.keys(leaky).filter((k) => line.split(' ').includes(k)));
  ok('the read of test sees none of the proxy, CA or other variables of the environment (env -i, PATH only)',
    r.status === 0 && seen.length >= 1 && leaked.length === 0, `${tail(r)} lines=${seen.length} leaked=${[...new Set(leaked)]}`);
  ok('the read of test runs with GIT_TERMINAL_PROMPT=0', seen.length >= 1 && seen.every((line) => / GIT_TERMINAL_PROMPT_VALUE=0$/.test(` ${line}`)),
    seen.map((l) => l.slice(-40)).join(' | '));

  // A planted system gitconfig redirecting test to the unmerged commit: ignored.
  const sysConfig = path.join(stubBin, 'system-gitconfig');
  fs.writeFileSync(sysConfig, `[url "${evil}"]\n\tinsteadOf = ${CANONICAL}\n`);
  fs.writeFileSync(path.join(stubBin, 'fake-github'), planted.canon);
  const sysControl = spawnSync('git', ['ls-remote', CANONICAL, 'refs/heads/test'], { encoding: 'utf8', env: { PATH: [stubBin, SYS_PATH].join(':'), HOME: path.join(root, 'home') } });
  r = bootstrap(['--no-rulesets', '--apply'], { where: planted });
  fs.rmSync(sysConfig, { force: true });
  ok('control: a planted system gitconfig does redirect the canonical URL for an ordinary git call',
    sysControl.stdout.startsWith(execFileSync('git', ['-C', planted.work, 'rev-parse', 'HEAD']).toString().trim()), sysControl.stdout + sysControl.stderr);
  ok('--apply ignores an insteadOf in the system gitconfig (GIT_CONFIG_NOSYSTEM=1): refused, before any gh call',
    r.status !== 0 && /not on marvinamiranda\/\.github test/.test(r.stderr) && r.calls.length === 0, tail(r));

  const loose = fs.mkdtempSync(path.join(root, 'loose-'));
  fs.mkdirSync(path.join(loose, 'governance'));
  fs.copyFileSync(SCRIPT, path.join(loose, 'governance', 'bootstrap.sh'));
  withProvenance(path.join(loose, 'governance'));
  r = bootstrap(['--no-rulesets', '--apply'], { where: { script: path.join(loose, 'governance', 'bootstrap.sh'), canon: path.join(root, 'none.git') } });
  ok('--apply refuses to run from outside a git checkout', r.status !== 0 && /Refusing --apply/.test(r.stderr) && r.calls.length === 0, tail(r));
}

// --------------------------------------------- b) the default branch ----
{
  const withDefault = (branch) => fixtures({
    [`repos/${ORG}/prod`]: { name: 'prod', full_name: `${ORG}/prod`, default_branch: branch },
  });
  let r = bootstrap(['--no-rulesets'], { fx: withDefault('test') });
  const patch = r.stdout.match(/DRY-RUN would run: gh api -X PATCH repos\/[^/]+\/prod --input - <<JSON\n([\s\S]*?)\n\s*JSON\n/);
  ok('the default branch moves to dev at the cutover, when dev exists',
    r.status === 0 && patch && JSON.parse(patch[1]).default_branch === 'dev', `${tail(r)} ${patch && patch[1]}`);
  r = bootstrap(['--no-rulesets'], { fx: withDefault('dev') });
  ok('a repository already on dev is left alone', r.status === 0 && !/default_branch/.test(r.stdout) && /prod: dev/.test(r.stdout), tail(r));
  r = bootstrap(['--no-rulesets'], { fx: fixtures({
    [`repos/${ORG}/prod`]: { name: 'prod', full_name: `${ORG}/prod`, default_branch: 'test' },
    [`repos/${ORG}/prod/branches/dev`]: undefined,
  }) });
  ok('a repository without dev keeps its default branch, with a warning',
    r.status === 0 && /WARNING: .*no dev branch/.test(r.stdout) && !/default_branch/.test(r.stdout), tail(r));
}

// ------------------------------------------------------- the rulesets ----
{
  const r = bootstrap([]);
  const plan = planned(r.stdout);
  const d = plan['prod/dev-integration'];
  const t = plan['prod/test-integration'];
  const m = plan['prod/main-checks'];
  const self = plan['.github/test-integration'];
  ok('a dry run with rulesets plans dev, test and main for a product and test/main for this repository',
    r.status === 0 && d && t && m && self && !plan['.github/dev-integration'], `${tail(r)} planned=${Object.keys(plan)}`);
  ok('dev-integration and test-integration allow merge commits only, matching one history across dev, test and main',
    d && t
      && JSON.stringify(pr(d.body).allowed_merge_methods) === '["merge"]'
      && JSON.stringify(pr(t.body).allowed_merge_methods) === '["merge"]',
    `dev=${d && JSON.stringify(pr(d.body).allowed_merge_methods)} test=${t && JSON.stringify(pr(t.body).allowed_merge_methods)}`);
  ok('dev-integration and test-integration forbid deletion and non-fast-forward, with no bypass',
    d && t
      && [d, t].every((rs) => rs.body.bypass_actors.length === 0
        && rs.body.rules.some((x) => x.type === 'deletion') && rs.body.rules.some((x) => x.type === 'non_fast_forward')),
    `${d && JSON.stringify(d.body.bypass_actors)} ${t && JSON.stringify(t.body.bypass_actors)}`);
  ok('dev-integration requires the dev checks, governance/issue-link and review/independent pinned to the Reviewer App',
    d && checks(d.body).some((c) => c.context === 'governance/issue-link' && c.integration_id === 15368)
      && checks(d.body).some((c) => c.context === 'review/independent' && c.integration_id === REVIEWER_ID),
    d && JSON.stringify(checks(d.body)));
  ok('test-integration requires governance/issue-link, test-source-policy and review/independent',
    t && checks(t.body).some((c) => c.context === 'governance/issue-link' && c.integration_id === CHECKS_ID)
      && checks(t.body).some((c) => c.context === 'test-source-policy' && c.integration_id === 15368)
      && checks(t.body).some((c) => c.context === 'review/independent' && c.integration_id === REVIEWER_ID),
    t && JSON.stringify(checks(t.body)));
  ok('main-checks requires governance/issue-link and main-source-policy, with no bypass, and allows merge commits only',
    m && checks(m.body).some((c) => c.context === 'main-source-policy' && c.integration_id === 15368)
      && m.body.bypass_actors.length === 0 && JSON.stringify(pr(m.body).allowed_merge_methods) === '["merge"]',
    m && JSON.stringify(checks(m.body)));
  ok('.github\'s own test-integration requires governance tests and review/independent pinned to the Reviewer App',
    self && checks(self.body).some((c) => c.context === 'governance tests' && c.integration_id === 15368)
      && checks(self.body).some((c) => c.context === 'review/independent' && c.integration_id === REVIEWER_ID),
    self && JSON.stringify(checks(self.body)));

  if (t) {
    // What GitHub would return for the same ruleset, methods in another order.
    const existing = { ...t.body, id: 7, source_type: 'Repository',
      rules: t.body.rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { ...x.parameters, allowed_merge_methods: ['merge'] } } : x)) };
    let again = bootstrap([], { fx: fixtures({
      [`repos/${ORG}/prod/rulesets?includes_parents=true&per_page=100`]: [{ id: 7, name: 'test-integration', source_type: 'Repository' }],
      [`repos/${ORG}/prod/rulesets/7`]: existing }) });
    ok('an existing test-integration listing the same methods in another order is up to date (no PUT)',
      /Ruleset test-integration: up to date\./.test(again.stdout) && !planned(again.stdout)['prod/test-integration'], tail(again));

    const noMethods = { ...existing, rules: existing.rules.map((x) => (x.type === 'pull_request'
      ? { ...x, parameters: Object.fromEntries(Object.entries(x.parameters).filter(([k]) => k !== 'allowed_merge_methods')) } : x)) };
    again = bootstrap([], { fx: fixtures({
      [`repos/${ORG}/prod/rulesets?includes_parents=true&per_page=100`]: [{ id: 7, name: 'test-integration', source_type: 'Repository' }],
      [`repos/${ORG}/prod/rulesets/7`]: noMethods }) });
    ok('an existing test-integration with no allowed_merge_methods (GitHub\'s default: all three) differs, and is updated',
      again.status === 0 && /Ruleset test-integration \(id 7\) differs/.test(again.stdout)
        && planned(again.stdout)['prod/test-integration'] && planned(again.stdout)['prod/test-integration'].method === 'PUT', tail(again));
  }
}

// ---------------------------------------------- N5: probe without rulesets ----
{
  const r = bootstrap(['--probe', '--no-rulesets']);
  ok('--probe --no-rulesets plans the Reviewer App probe on each repository and no ruleset',
    r.status === 0 && /would post, as the Reviewer App \(5075711\): review\/independent=neutral on prod/.test(r.stdout)
      && /would post, as the Reviewer App \(5075711\): review\/independent=neutral on \.github/.test(r.stdout)
      && /== e\) Rulesets\n\s+skipped \(--no-rulesets\)/.test(r.stdout) && Object.keys(planned(r.stdout)).length === 0, tail(r));
}

// ------------------------------- R4: this repository's rulesets, on their own ----
{
  const touchesProd = (r) => r.calls.some((c) => c.args.some((a) => /\/prod(\/|$|\?)/.test(a)));
  let r = bootstrap(['--self-only'], { repo: false });
  const plan = planned(r.stdout);
  ok('--self-only needs no --repo and plans exactly this repository\'s three rulesets',
    r.status === 0 && JSON.stringify(Object.keys(plan).sort()) === JSON.stringify(['.github/main-checks', '.github/main-owner-only', '.github/test-integration']),
    `${tail(r)} planned=${Object.keys(plan)}`);
  ok('--self-only reads no product repository and skips issue types, default branches and labels',
    r.status === 0 && !touchesProd(r) && !r.calls.some((c) => c.args.includes(`orgs/${ORG}/issue-types`))
      && /== a\) Organisation issue types\n\s+skipped \(--self-only\)/.test(r.stdout),
    `${tail(r)} calls=${JSON.stringify(r.calls.map((c) => c.args.join(' ')))}`);
  const self = plan['.github/test-integration'];
  ok('--self-only: test-integration requires governance tests and review/independent from the Reviewer App',
    self && checks(self.body).some((c) => c.context === 'governance tests' && c.integration_id === 15368)
      && checks(self.body).some((c) => c.context === 'review/independent' && c.integration_id === REVIEWER_ID), self && JSON.stringify(checks(self.body)));

  for (const [what, args, says] of [
    ['--self-only with a --repo', ['--self-only', '--repo', 'prod'], /--self-only .*takes no --repo/],
    ['--self-only with --no-rulesets', ['--self-only', '--no-rulesets'], /--self-only applies rulesets/],
    ['--self-only with --project', ['--self-only', '--project', '--project-title', 'x'], /--self-only takes no --project/],
  ]) {
    r = bootstrap(args, { repo: false });
    ok(`${what} is a usage error, before any gh call`, r.status === 2 && says.test(r.stderr) && !/Unknown argument/.test(r.stderr) && r.calls.length === 0, tail(r));
  }
  r = bootstrap([], { repo: false });
  ok('no --repo and no --self-only is a usage error that names --self-only',
    r.status === 2 && /At least one --repo is required, or --self-only/.test(r.stderr) && r.calls.length === 0, tail(r));
  r = bootstrap(['--self-only'], { repo: false, reviewer: false });
  ok('--self-only without a Reviewer App id aborts before any gh call',
    r.status === 1 && /No Reviewer App id, so no rulesets/.test(r.stderr) && !/Unknown argument/.test(r.stderr) && r.calls.length === 0, tail(r));
  r = bootstrap(['--self-only', '--apply'], { repo: false, on: 'elsewhere' });
  ok('--self-only --apply refuses a commit that is not on test, before any gh call',
    r.status !== 0 && /Refusing --apply/.test(r.stderr) && r.calls.length === 0, tail(r));

  // --apply once this repository's rulesets are as planned: nothing to write.
  const listed = [];
  const extra = {};
  Object.values(plan).forEach(({ body }, i) => {
    listed.push({ id: 100 + i, name: body.name, source_type: 'Repository' });
    extra[`repos/${ORG}/.github/rulesets/${100 + i}`] = { ...body, id: 100 + i, source_type: 'Repository' };
  });
  extra[`repos/${ORG}/.github/rulesets?includes_parents=true&per_page=100`] = listed;
  r = bootstrap(['--self-only', '--apply'], { repo: false, fx: fixtures(extra) });
  ok('--self-only --apply from a commit on test, with the rulesets in place: up to date, nothing written',
    r.status === 0 && /0 change\(s\) applied/.test(r.stdout) && r.writes.length === 0 && (r.stdout.match(/up to date\./g) || []).length === 3, tail(r));

  r = bootstrap(['--self-only', '--probe'], { repo: false });
  ok('--self-only --probe plans the probe on this repository alone',
    r.status === 0 && /review\/independent=neutral on \.github/.test(r.stdout) && !/neutral on prod/.test(r.stdout), tail(r));

  // In a run with --repo too, this repository's rulesets come first.
  r = bootstrap([]);
  const order = [...r.stdout.matchAll(/^\s+\[([^\]]+)\]$/gm)].map((m) => m[1]);
  const rulesetsAt = r.stdout.indexOf('== e) Rulesets');
  const inE = [...r.stdout.slice(rulesetsAt).matchAll(/^\s+\[([^\]]+)\]$/gm)].map((m) => m[1]);
  ok('a run with --repo applies this repository\'s rulesets before any product repository\'s',
    r.status === 0 && inE[0] === '.github' && inE.includes('prod'), `${tail(r)} order=${JSON.stringify(inE)} all=${JSON.stringify(order)}`);
}

// ------------------------------ g) the governance-checks environment ----
// The Checks App's key lives only here (.github#9): custom deployment branches,
// exactly one rule, the default branch. Anything else is drift.
{
  const WANT_ENV = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  const WANT_RULE = [{ name: 'dev', type: 'branch' }];
  const envPlan = (stdout) => {
    const out = { put: [], post: [], del: [] };
    for (const m of stdout.matchAll(/DRY-RUN would run: gh api -X (PUT|POST) repos\/[^/]+\/prod\/environments\/governance-checks(\S*) --input - <<JSON\n([\s\S]*?)\n\s*JSON\n/g)) {
      (m[1] === 'PUT' && m[2] === '' ? out.put : out.post).push(JSON.parse(m[3]));
    }
    for (const m of stdout.matchAll(/DRY-RUN would run: gh api -X DELETE repos\/[^/]+\/prod\/environments\/governance-checks\/deployment-branch-policies\/(\d+)/g)) out.del.push(Number(m[1]));
    return out;
  };
  const rulesIn = (state) => ((state[RULES_PATH('prod')] || {}).branch_policies || []).map((b) => ({ name: b.name, type: b.type }));
  const policyIn = (state) => (state[ENV_PATH('prod')] || {}).deployment_branch_policy;
  const envSection = (r) => r.stdout.slice(r.stdout.indexOf('== g)'));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Absent: planned exactly, then applied, then a second run writes nothing.
  let r = bootstrap(['--no-rulesets'], { fx: fixtures(environment('prod', { rules: null })) });
  let plan = envPlan(r.stdout);
  ok('a dry run with no governance-checks environment plans it: custom branch policies, protected branches false',
    r.status === 0 && plan.put.length === 1 && same(plan.put[0], WANT_ENV) && r.writes.length === 0, `${tail(r)} ${JSON.stringify(plan)}`);
  ok('...and exactly one deployment rule: the default branch, dev, as a branch rule',
    same(plan.post, WANT_RULE) && plan.del.length === 0, JSON.stringify(plan));

  r = bootstrap(['--no-rulesets', '--apply'], { fx: fixtures(environment('prod', { rules: null })), writable: true });
  ok('--apply creates governance-checks with custom policies and exactly one rule, dev',
    r.status === 0 && same(policyIn(r.state), WANT_ENV.deployment_branch_policy) && same(rulesIn(r.state), WANT_RULE) && r.writes.length === 2,
    `${tail(r)} policy=${JSON.stringify(policyIn(r.state))} rules=${JSON.stringify(rulesIn(r.state))} writes=${r.writes.length}`);
  const again = bootstrap(['--no-rulesets', '--apply'], { fx: r.state, writable: true });
  ok('the same --apply again makes no write call', again.status === 0 && again.writes.length === 0 && /0 change\(s\) applied/.test(again.stdout)
    && /governance-checks: up to date/.test(again.stdout), `${tail(again)} writes=${JSON.stringify(again.writes.map((w) => w.args.join(' ')))}`);

  // Drift: every rule but the default branch is reported, then removed.
  for (const [what, extra] of [
    ['refs/pull/*', { id: 2, name: 'refs/pull/*', type: 'branch' }],
    ['*', { id: 3, name: '*', type: 'branch' }],
    ['a tag rule named dev', { id: 4, name: 'dev', type: 'tag' }],
  ]) {
    const fx = fixtures(environment('prod', { rules: [{ id: 1, name: 'dev', type: 'branch' }, extra] }));
    r = bootstrap(['--no-rulesets'], { fx });
    plan = envPlan(r.stdout);
    ok(`a dry run reports an extra ${what} rule as drift and plans its removal, keeping dev`,
      r.status === 0 && new RegExp(`DRIFT: .*'${extra.name.replace(/\*/g, '\\*')}' \\(${extra.type}`).test(envSection(r))
        && same(plan.del, [extra.id]) && plan.post.length === 0 && plan.put.length === 0 && r.writes.length === 0, `${tail(r)} ${JSON.stringify(plan)}`);
    r = bootstrap(['--no-rulesets', '--apply'], { fx, writable: true });
    ok(`--apply removes the ${what} rule and leaves only dev`, r.status === 0 && same(rulesIn(r.state), WANT_RULE)
      && same(policyIn(r.state), WANT_ENV.deployment_branch_policy), `${tail(r)} rules=${JSON.stringify(rulesIn(r.state))}`);
    const second = bootstrap(['--no-rulesets', '--apply'], { fx: r.state, writable: true });
    ok(`...and a second --apply after removing ${what} writes nothing`, second.status === 0 && second.writes.length === 0, tail(second));
  }
  // Only a tag rule named dev: the tag goes, the branch rule is created.
  r = bootstrap(['--no-rulesets', '--apply'], { fx: fixtures(environment('prod', { rules: [{ id: 4, name: 'dev', type: 'tag' }] })), writable: true });
  ok('an environment whose only rule is a tag named dev ends with the branch rule alone', r.status === 0 && same(rulesIn(r.state), WANT_RULE), JSON.stringify(rulesIn(r.state)));

  // The environment's own policy: protected branches, or none at all.
  for (const [what, policy] of [['protected branches', { protected_branches: true, custom_branch_policies: false }], ['every branch (no policy)', null]]) {
    const fx = fixtures(environment('prod', { policy }));
    r = bootstrap(['--no-rulesets'], { fx });
    plan = envPlan(r.stdout);
    ok(`a dry run reports an environment allowing ${what} as drift and plans the custom policy`,
      r.status === 0 && /DRIFT: .*deployment/.test(envSection(r)) && plan.put.length === 1 && same(plan.put[0], WANT_ENV) && same(plan.post, WANT_RULE),
      `${tail(r)} ${JSON.stringify(plan)}`);
    r = bootstrap(['--no-rulesets', '--apply'], { fx, writable: true });
    ok(`--apply turns an environment allowing ${what} into custom policies with only test`,
      r.status === 0 && same(policyIn(r.state), WANT_ENV.deployment_branch_policy) && same(rulesIn(r.state), WANT_RULE), `${tail(r)} ${JSON.stringify(policyIn(r.state))}`);
  }

  // Not with --self-only, and not for a repository dev is not the default of.
  r = bootstrap(['--self-only'], { repo: false });
  ok('--self-only reads and plans no environment', r.status === 0 && !r.calls.some((c) => c.args.some((a) => /environments/.test(a)))
    && /== g\) [^\n]*\n\s+skipped \(--self-only\)/.test(r.stdout), tail(r));
  const noDev = fixtures({ ...environment('prod', { rules: null }), [`repos/${ORG}/prod`]: { name: 'prod', full_name: `${ORG}/prod`, default_branch: 'main' },
    [`repos/${ORG}/prod/branches/dev`]: undefined });
  r = bootstrap(['--no-rulesets'], { fx: noDev });
  plan = envPlan(r.stdout);
  ok('a repository with no dev branch gets no environment, with a warning', r.status === 0 && plan.put.length === 0 && plan.post.length === 0
    && /WARNING: .*governance-checks/.test(envSection(r)), `${tail(r)} ${JSON.stringify(plan)}`);
}

// -------------------------------------- the credential for --apply ----
{
  // Advice to ADD a scope to the gh login (gh auth refresh ... -s <scope>).
  const addsScope = /gh auth refresh\b[^\n]*\s-s\s/;
  const noRefresh = (r) => !addsScope.test(r.stdout + r.stderr);
  let r = bootstrap(['--no-rulesets'], { extraEnv: { GH_TOKEN: 'github_pat_FAKE' } });
  ok('a fine-grained token in GH_TOKEN is named as such, with no scope warning (it has no scopes)',
    r.status === 0 && /fine-grained/.test(r.stdout) && !/WARNING/.test(r.stdout) && noRefresh(r), tail(r));
  r = bootstrap(['--no-rulesets', '--apply']);
  ok('--apply on the keyring login warns: a one-day fine-grained token as GH_TOKEN, never admin:org on the keyring login',
    r.status === 0 && /WARNING: .*keyring/.test(r.stdout) && /fine-grained/.test(r.stdout) && /admin:org/.test(r.stdout) && noRefresh(r), tail(r));
  r = bootstrap(['--no-rulesets'], { extraEnv: { FAKE_GH_SCOPES: "'repo'" } });
  ok('a dry run never advises adding admin:org to the gh login', r.status === 0 && noRefresh(r), tail(r));

  const help = spawnSync(BASH, [SCRIPT, '--help'], { encoding: 'utf8', env: { ...process.env, PATH: SYS_PATH } });
  const text = help.stdout;
  ok('--help lists the fine-grained token\'s permissions for each step',
    help.status === 0 && /fine-grained/i.test(text) && /Issue Types: read and write/.test(text) && /Administration: read and write/.test(text)
      && /Contents: read/.test(text) && /Issues: read and write/.test(text) && /Projects: read and write/.test(text) && /Metadata: read/.test(text)
      && /Reviewer App/.test(text) && !addsScope.test(text), text.slice(0, 200));
  ok('--help says --no-rulesets (and every product step) runs after the adoption pull request has merged, and names --self-only',
    /--no-rulesets[\s\S]{0,300}after[\s\S]{0,60}adoption\s+pull\s+request\s+has\s+merged/.test(text) && /--self-only/.test(text)
      && !/stage an adoption/.test(text), '');
}

// Evidence for a pull request: with BOOTSTRAP_DRY_RUN_OUT set, write the full
// dry-run output (the payloads every step would send) to that path. Off by
// default, so the suite stays quiet.
if (process.env.BOOTSTRAP_DRY_RUN_OUT) {
  const dump = bootstrap([]);
  fs.writeFileSync(process.env.BOOTSTRAP_DRY_RUN_OUT, dump.stdout);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
