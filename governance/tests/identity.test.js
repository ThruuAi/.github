#!/usr/bin/env node
'use strict';

// governance/identity/ (agent-env.sh, gh-shim.sh, app-token.sh) against a fake
// GitHub. A stub `curl` first on PATH answers the App endpoints from a
// scenario file, and a stub "real gh" records the token and config directory
// it was run with. HOME is a throwaway directory holding a throwaway key, so
// nothing here reaches the network or the owner's login.
//
// The scripts run from a throwaway git checkout, because agent-env.sh refuses
// one whose scripts differ from its HEAD and warns when HEAD is not on
// marvinamiranda/.github test. That repository is a local bare one here,
// reached through a stub `git` first on PATH that serves
// https://github.com/marvinamiranda/.github.git from it (agent-env.sh fetches
// test with a clean configuration, so no insteadOf could), so its `test` is
// whatever a case says.
//
// The fake HOME also holds zsh startup files shaped like the owner's: a
// .zprofile and a .zshrc that put a directory holding another "real" gh first
// on PATH (as `brew shellenv` does), and a .zshrc that exports
// GH_PACKAGES_TOKEN from `gh auth token`.
//
//   node governance/tests/identity.test.js
//
// IDENTITY_DIR points it at another copy of governance/identity/, which is how
// a deliberately broken copy is shown to turn this suite red. IDENTITY_BASH
// runs every script under that bash (for example /bin/bash, macOS bash 3.2).
// IDENTITY_REQUIRE_ZSH=1 (CI) makes a missing zsh a failure, not a skip.
// IDENTITY_README points the check of the documented per-command forms at
// another copy of README.md.

const { spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { forgeCommitGraph } = require('./commit-graph-forge');
const { forgePackParent, forgeLooseObject, BACKDATED } = require('./object-forge');

// The PATH every child gets after its own directories: the absolute entries
// of this process's, since bootstrap.sh and create-app.py refuse an empty or
// relative entry (a developer's PATH can hold one, such as a literal ~/...).
const SYS_PATH = (process.env.PATH || '').split(':').filter((e) => e.startsWith('/')).join(':');
const IDENTITY_SRC = process.env.IDENTITY_DIR
  ? path.resolve(process.env.IDENTITY_DIR)
  : path.join(__dirname, '..', 'identity');
const SCRIPTS = ['agent-env.sh', 'gh-shim.sh', 'app-token.sh', 'provenance.sh'];
const NAME = 'mm-agent';
const SLUG = 'fake-agent';
const ORG = 'marvinamiranda';
const API = 'https://api.github.com';
const CANONICAL = `https://github.com/${ORG}/.github.git`;
const OWNER = 'gho_OWNERxOWNERxOWNERxOWNERxOWNERxOWNER1';
const PKG = `ghp_${'P'.repeat(36)}`;
const SENTINEL_RE = /^mm-agent-sentinel-not-a-token$/;

let failed = 0;
let total = 0;
function ok(name, condition, detail = '') {
  total += 1;
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

// ------------------------------------------------------------- the world ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
const home = path.join(root, 'home');
const gitHome = path.join(root, 'git-home'); // HOME for this file's own git commands
const stubBin = path.join(root, 'stub-bin'); // curl (and bash, with IDENTITY_BASH)
const realBin = path.join(root, 'real-bin'); // the gh the shim must hand off to
const brewBin = path.join(root, 'brew-bin'); // another real gh, which the owner's startup files put first
const scenarioFile = path.join(root, 'scenario.json');
const curlLog = path.join(root, 'curl.log');
const ghLog = path.join(root, 'real-gh.log');
const brewLog = path.join(root, 'brew-gh.log');
const src = path.join(root, 'src'); // the checkout the scripts run from
const canon = path.join(root, 'canon.git'); // stands in for marvinamiranda/.github
const IDENTITY = path.join(src, 'governance', 'identity');
const POST_REVIEW = path.join(IDENTITY, 'post-review.sh');
const ROOT = path.join(home, '.config', 'mm-agent');
const DIR = path.join(ROOT, NAME);
const CACHE = path.join(DIR, 'token.cache');
const PACKAGES = path.join(ROOT, 'packages-token');
const REAL_GH = path.join(realBin, 'gh');
const REVIEW_SHA = 'a3ff6b5a1f95bd8d45605d122fbf4cecc0189d6f';

for (const d of [stubBin, realBin, brewBin, gitHome]) fs.mkdirSync(d, { recursive: true });

// curl: answers "<METHOD> <URL>" from the scenario; an array is served in
// order, its last entry repeating. Understands the flags the scripts use.
fs.writeFileSync(path.join(stubBin, 'curl'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let out = null, fmt = null, method = 'GET', fail = false, url = null;
const headers = [];
if (args.includes('-K')) { for (const l of fs.readFileSync(0, 'utf8').split('\\n')) { const m = /^header = "(.*)"$/.exec(l); if (m) headers.push(m[1]); } }
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') out = args[++i];
  else if (a === '-w') fmt = args[++i];
  else if (a === '-X') method = args[++i];
  else if (a === '-H') headers.push(args[++i]);
  else if (/^https?:/.test(a)) url = a;
  else if (/^-[A-Za-z]+$/.test(a) && a.includes('f')) fail = true;
}
const auth = (headers.find((h) => /^authorization:/i.test(h)) || '').replace(/^authorization:\\s*/i, '');
fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify({ method, url, auth, argv: args }) + '\\n');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
const key = method + ' ' + url;
let r = scenario[key];
if (Array.isArray(r)) {
  const countFile = process.env.FAKE_GH_SCENARIO + '.count';
  const counts = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, 'utf8')) : {};
  const n = counts[key] || 0;
  counts[key] = n + 1;
  fs.writeFileSync(countFile, JSON.stringify(counts));
  r = r[Math.min(n, r.length - 1)];
}
if (!r) r = { status: 404, body: { message: 'Not Found (stub)' } };
const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
if (fail && r.status >= 400) { process.stderr.write('curl: (22) The requested URL returned error: ' + r.status + '\\n'); process.exit(22); }
if (out) fs.writeFileSync(out, body); else process.stdout.write(body);
if (fmt) process.stdout.write(fmt.replace('%{http_code}', String(r.status)));
`, { mode: 0o755 });

// The "real" gh: records what it was given. Reaching it is the only way a
// command can act on GitHub, so every refusal is checked against this log.
fs.writeFileSync(REAL_GH, `#!/usr/bin/env node
const input = require('fs').readFileSync(0, 'utf8');
require('fs').appendFileSync(process.env.FAKE_REAL_GH_LOG, JSON.stringify({
  token: process.env.GH_TOKEN === undefined ? null : process.env.GH_TOKEN,
  config: process.env.GH_CONFIG_DIR === undefined ? null : process.env.GH_CONFIG_DIR,
  ghHost: process.env.GH_HOST === undefined ? null : process.env.GH_HOST,
  enterpriseToken: process.env.GH_ENTERPRISE_TOKEN === undefined ? null : process.env.GH_ENTERPRISE_TOKEN,
  githubEnterpriseToken: process.env.GITHUB_ENTERPRISE_TOKEN === undefined ? null : process.env.GITHUB_ENTERPRISE_TOKEN,
  args: process.argv.slice(2), input }) + '\\n');
console.log('real gh ran: ' + process.argv.slice(2).join(' '));
process.exit(Number(process.env.FAKE_REAL_GH_EXIT || 0));
`, { mode: 0o755 });
const REAL_GH_CANON = fs.realpathSync(REAL_GH);

// The gh the owner's startup files put first (Homebrew's, on the owner's
// machine). Like the real one it answers `gh auth token` with GH_TOKEN when
// that is set, and otherwise, or with --user, with the keyring login: OWNER.
fs.writeFileSync(path.join(brewBin, 'gh'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(brewLog)}
if [ "$1" = auth ] && [ "$2" = token ]; then
  case " $* " in *" --user "*) echo ${OWNER}; exit 0 ;; esac
  if [ -n "\${GH_TOKEN-}" ]; then echo "$GH_TOKEN"; else echo ${OWNER}; fi
  exit 0
fi
echo "brew gh ran: $*"
`, { mode: 0o755 });

// git: the real one, except that the canonical URL is served by the local
// bare repository standing in for GitHub.
const AGENT_REAL_GIT = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(path.join(stubBin, 'git'), `#!/usr/bin/env bash
args=()
for a in "$@"; do if [ "$a" = ${JSON.stringify(CANONICAL)} ]; then args+=(${JSON.stringify(canon)}); else args+=("$a"); fi; done
exec ${JSON.stringify(AGENT_REAL_GIT)} "\${args[@]}"
`, { mode: 0o755 });

if (process.env.IDENTITY_BASH) fs.symlinkSync(path.resolve(process.env.IDENTITY_BASH), path.join(stubBin, 'bash'));
const BASH = process.env.IDENTITY_BASH ? path.resolve(process.env.IDENTITY_BASH) : 'bash';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// ---------------------------------------------- the checkout and its test ----
const gitEnv = { PATH: SYS_PATH, HOME: gitHome, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com',
  '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe', env: gitEnv }).toString().trim();
fs.mkdirSync(IDENTITY, { recursive: true });
for (const f of SCRIPTS) {
  fs.copyFileSync(path.join(IDENTITY_SRC, f), path.join(IDENTITY, f));
  fs.chmodSync(path.join(IDENTITY, f), 0o755);
}
fs.copyFileSync(path.join(IDENTITY_SRC, 'post-review.sh'), path.join(IDENTITY, 'post-review.sh'));
fs.chmodSync(path.join(IDENTITY, 'post-review.sh'), 0o755);
git(root, 'init', '-q', src);
git(src, 'add', '.');
git(src, 'commit', '-q', '-m', 'identity scripts');
const COMMIT = git(src, 'rev-parse', 'HEAD');
git(root, 'init', '-q', '--bare', canon);
git(canon, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
git(src, 'push', '-q', canon, 'HEAD:refs/heads/test');
const SHIM = (sha = COMMIT) => path.join(DIR, 'shim', sha);

// Where marvinamiranda/.github `test` is: 'head' (the checkout's commit),
// 'ahead' (a later commit the checkout does not have), 'elsewhere' (an
// unrelated commit), 'gone' (the repository cannot be read).
function canonTest(kind) {
  if (fs.existsSync(`${canon}.gone`)) fs.renameSync(`${canon}.gone`, canon);
  const head = git(src, 'rev-parse', 'HEAD');
  if (kind === 'head') git(src, 'push', '-q', '-f', canon, 'HEAD:refs/heads/test');
  if (kind === 'ahead') {
    const later = git(canon, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'later');
    git(canon, 'update-ref', 'refs/heads/test', later);
  }
  if (kind === 'elsewhere') {
    const empty = git(canon, 'hash-object', '-t', 'tree', '-w', '/dev/null');
    git(canon, 'update-ref', 'refs/heads/test', git(canon, 'commit-tree', empty, '-m', 'unrelated'));
  }
  if (kind === 'gone') fs.renameSync(canon, `${canon}.gone`);
}

const now = () => Math.floor(Date.now() / 1000);
const iso = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const minted = (token) => (typeof token === 'object' ? token
  : { status: 201, body: { token, expires_at: iso(now() + 3600) } });

// The owner's zsh startup files, shaped like the real ones.
function ownerShellFiles() {
  const w = (f, s) => fs.writeFileSync(path.join(home, f), s);
  w('.zshenv', 'export OWNER_ZSHENV=e OWNER_SAW_ZDOTDIR="${ZDOTDIR-}"\n');
  w('.zprofile', `export PATH=${JSON.stringify(brewBin)}":$PATH"\nexport OWNER_ZPROFILE=p\n`);
  w('.zshrc', [
    `export PATH=${JSON.stringify(brewBin)}":$PATH"`,
    '# SM360 GitHub Packages, as in the owner\'s .zshrc',
    'if token="$(gh auth token 2>/dev/null)" && [ -n "$token" ]; then',
    '  export GH_PACKAGES_TOKEN="$token"',
    'fi',
    'export OWNER_ZSHRC=r',
    '# an alias named gh, as a plugin might define: it would shadow any PATH',
    `alias gh='echo OWNER-ALIAS'`,
    '',
  ].join('\n'));
  w('.zlogin', 'export OWNER_ZLOGIN=l\n');
}

// A fresh HOME holding the App's id, slug and key and the owner's shell files;
// and a fresh GitHub.
function fresh({ installation = { status: 200, body: { id: 42 } }, tokens = ['ghs_T1'] } = {}) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(DIR, 'app.json'), JSON.stringify({ id: 111, slug: SLUG, name: 'Fake Agent' }), { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, 'private-key.pem'), privateKey, { mode: 0o600 });
  ownerShellFiles();
  world({ installation, tokens });
}
// Change what GitHub answers, keeping HOME (a session whose App breaks).
function world({ installation = { status: 200, body: { id: 42 } }, tokens = ['ghs_T1'] } = {}) {
  fs.writeFileSync(scenarioFile, JSON.stringify({
    [`GET ${API}/orgs/${ORG}/installation`]: installation,
    [`POST ${API}/app/installations/42/access_tokens`]: tokens.map(minted),
    [`GET ${API}/users/${SLUG}%5Bbot%5D`]: { status: 200, body: { id: 99, login: `${SLUG}[bot]` } },
  }));
  fs.rmSync(`${scenarioFile}.count`, { force: true });
  for (const f of [curlLog, ghLog, brewLog]) fs.writeFileSync(f, '');
}
const readOr = (file, otherwise = '') => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return otherwise; } };
const listOr = (dir) => { try { return fs.readdirSync(dir); } catch (e) { return []; } };
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const records = (file) => lines(file).map((l) => JSON.parse(l));
const mints = () => records(curlLog).filter((c) => c.method === 'POST' && /access_tokens$/.test(c.url)).length;
const ghRuns = () => records(ghLog);

// Cache line 1 is "<expiry> <token>" (what older copies of app-token.sh read);
// line 2, when present, is when the token was minted.
function writeCache({ token, mintedAgo = 0, expiresIn = 3600 - mintedAgo, oneLine = false }) {
  fs.mkdirSync(DIR, { recursive: true });
  const first = `${now() + expiresIn} ${token}\n`;
  fs.writeFileSync(CACHE, oneLine ? first : `${first}${now() - mintedAgo}\n`, { mode: 0o600 });
}

function writeReviewerFixture() {
  const dir = path.join(ROOT, 'mm-reviewer');
  const minted = now();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ id: 222, slug: 'fake-reviewer', name: 'Fake Reviewer' }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'private-key.pem'), privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'token.cache'), `${minted + 3600} ghs_REVIEWER_FIXTURE\n${minted}\n`, { mode: 0o600 });
}

function env(extra = {}) {
  return {
    HOME: home,
    PATH: [stubBin, realBin, path.dirname(process.execPath), SYS_PATH].join(':'),
    TMPDIR: root,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    FAKE_GH_SCENARIO: scenarioFile,
    FAKE_CURL_LOG: curlLog,
    FAKE_REAL_GH_LOG: ghLog,
    ...extra,
  };
}
const run = (args, extra) => spawnSync(BASH, args, { env: env(extra), encoding: 'utf8' });
const agentEnv = (extra, name = NAME, from = IDENTITY) => run([path.join(from, 'agent-env.sh'), name], extra);
const appToken = () => run([path.join(IDENTITY, 'app-token.sh'), NAME]);
// Evaluate the printed environment in a child shell, then run `script` in a
// GRANDCHILD (bash -c), which sees only what the child exported: a tool shell,
// a script, a `bash -c`. "eval-rc=<n>" on stderr is the eval's own status.
const inChild = (printed, script, extra) =>
  run(['-c', 'eval "$1"; echo "eval-rc=$?" >&2; bash -c "$2"', '_', printed, script], extra);
// The same, where the grandchild is zsh started with `flags` (-lc, -lic, -ic),
// so it reads the startup files: the owner's, through ZDOTDIR.
const inZsh = (printed, flags, script, extra) =>
  run(['-c', `eval "$1"; exec zsh ${flags} "$2"`, '_', printed, script], extra);

const CRED = 'printf "protocol=https\\nhost=github.com\\npath=o/r.git\\n\\n" | git credential fill; echo "git-rc=$?"';
const rcOf = (out, label) => { const m = new RegExp(`${label}=(\\d+)`).exec(out); return m ? Number(m[1]) : null; };
const field = (out, label) => { const m = new RegExp(`^${label}=(.*)$`, 'm').exec(out); return m ? m[1] : null; };

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0;
function zshOrSkip(what) {
  if (hasZsh) return true;
  if (process.env.IDENTITY_REQUIRE_ZSH) ok(`${what} (zsh is required here)`, false, 'zsh not installed');
  else console.log(`ok - # SKIP zsh not installed: ${what}`);
  return false;
}



// The saved per-command environment must trust canonical install-time bytes,
// not merely any executable currently found at either launcher path.
(function savedLauncherIntegrity() {
  const secrets = [OWNER, PKG, 'ghs_T1', 'ghs_GUARD_THRUU'];
  const setup = () => {
    fresh(); canonTest('head');
    const scenario = JSON.parse(readOr(scenarioFile));
    scenario[`GET ${API}/orgs/ThruuAi/installation`] = { status: 200, body: { id: 43 } };
    scenario[`POST ${API}/app/installations/43/access_tokens`] = minted('ghs_GUARD_THRUU');
    fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
    const installed = agentEnv();
    ok('saved launcher integrity fixture installs from canonical source', installed.status === 0, '');
    return path.join(DIR, 'env');
  };
  const clearCalls = () => {
    for (const f of [curlLog, ghLog, brewLog]) fs.writeFileSync(f, '');
    for (const f of [CACHE, `${CACHE}.thruuai`]) fs.rmSync(f, { force: true });
  };
  const invoke = (saved, command, extra = {}) => run(['-c', `source "$1" && ${command}`, '_', saved], extra);
  let saved = setup();
  for (const [command, token] of [['gh api canonical', 'ghs_T1'], ['mm-gh-org marvinamiranda api canonical', 'ghs_T1'],
    ['mm-gh-org ThruuAi api canonical', 'ghs_GUARD_THRUU']]) {
    clearCalls();
    const r = invoke(saved, command, { FAKE_REAL_GH_EXIT: '29' });
    const runs = ghRuns();
    ok(`untouched saved launcher pair preserves ${command} token environment and exit 29`,
      r.status === 29 && runs.length === 1 && runs[0].token === token && readOr(brewLog) === '', '');
    ok(`untouched saved launcher pair exposes no sentinel output/argv for ${command}`,
      !secrets.some((t) => (r.stdout + r.stderr).includes(t))
        && runs.every((c) => !secrets.some((t) => c.args.join(' ').includes(t)))
        && records(curlLog).every((c) => !/ghs_|eyJ/.test(c.argv.join(' '))), '');
  }
  for (const launcher of ['gh', 'mm-gh-org']) {
    for (const damage of ['missing', 'tampered executable', 'owner fallback executable', 'matching symlink']) {
      saved = setup();
      const file = path.join(SHIM(), 'bin', launcher);
      if (damage === 'missing') fs.rmSync(file);
      else if (damage === 'tampered executable') fs.appendFileSync(file, '\n# executable bytes changed without reinstall\n');
      else if (damage === 'owner fallback executable') {
        fs.writeFileSync(file, `#!/usr/bin/env bash\nunset GH_TOKEN GH_CONFIG_DIR\nexec ${JSON.stringify(path.join(brewBin, 'gh'))} api owner-fallback\n`, { mode: 0o700 });
      } else {
        const external = path.join(root, 'matching-launcher');
        fs.copyFileSync(file, external); fs.chmodSync(external, 0o700);
        fs.rmSync(file); fs.symlinkSync(external, file);
      }
      const caller = path.join(root, 'guarded-caller-ran');
      fs.rmSync(caller, { force: true }); clearCalls();
      // No reinstall between damage and sourcing; caller marker is before
      // invocation, so a rejected executable alone cannot satisfy this proof.
      const command = `${launcher}${launcher === 'mm-gh-org' ? ' ThruuAi' : ''} api guarded`;
      const r = invoke(saved, `{ echo caller > ${JSON.stringify(caller)}; ${command}; }`);
      ok(`saved env refuses ${damage} ${launcher} without reinstall before caller/owner-gh/mint/API/gh`,
        r.status !== 0 && !fs.existsSync(caller) && readOr(brewLog) === '' && ghRuns().length === 0 && records(curlLog).length === 0, '');
      ok(`saved env refusal for ${damage} ${launcher} prints no sentinel credentials`,
        !secrets.some((t) => (r.stdout + r.stderr).includes(t)), '');
    }
  }
})();

// Reinstall regenerates trusted routing from the committed source, including
// when an old stamp survives missing, corrupted or non-executable artifacts.
(function installedLifecycle() {
  fresh(); canonTest('head');
  const first = agentEnv();
  const artifacts = ['bin/gh', 'bin/mm-gh-org', 'libexec/gh-shim.sh', 'libexec/app-token.sh',
    'zdotdir/reassert.zsh', 'zdotdir/.zshenv', 'zdotdir/.zprofile', 'zdotdir/.zshrc', 'zdotdir/.zlogin', 'zdotdir/.zlogout'];
  const expected = Object.fromEntries(artifacts.map((f) => [f, fs.readFileSync(path.join(SHIM(), f))]));
  const repeat = agentEnv();
  ok('repeated installation preserves canonical launcher/libexec/startup bytes and executable modes',
    first.status === 0 && repeat.status === 0 && artifacts.every((f) => fs.readFileSync(path.join(SHIM(), f)).equals(expected[f]))
      && artifacts.filter((f) => !f.startsWith('zdotdir/')).every((f) => (fs.statSync(path.join(SHIM(), f)).mode & 0o100) !== 0), '');
  for (const f of artifacts) {
    for (const damage of ['missing', 'tampered', 'unreadable']) {
      const file = path.join(SHIM(), f);
      if (damage === 'missing') fs.rmSync(file);
      else if (damage === 'tampered') fs.appendFileSync(file, '\n# corrupted installed artifact\n');
      else fs.chmodSync(file, 0o000);
      const repaired = agentEnv();
      ok(`reinstallation repairs ${damage} ${f} despite an unchanged install stamp`,
        repaired.status === 0 && readOr(file, null) === expected[f].toString()
          && (fs.statSync(file).mode & (f.startsWith('zdotdir/') ? 0o400 : 0o500)) === (f.startsWith('zdotdir/') ? 0o400 : 0o500),
        `installer=${repaired.status}`);
    }
    if (!f.startsWith('libexec/')) {
      const file = path.join(SHIM(), f);
      const external = path.join(root, 'external-artifact');
      fs.writeFileSync(external, expected[f], { mode: f.startsWith('zdotdir/') ? 0o600 : 0o700 });
      fs.chmodSync(external, f.startsWith('zdotdir/') ? 0o600 : 0o700);
      fs.rmSync(file); fs.symlinkSync(external, file);
      const repaired = agentEnv();
      ok(`reinstallation replaces a matching symlink for ${f} with a canonical regular file`,
        repaired.status === 0 && !fs.lstatSync(file).isSymbolicLink() && readOr(file) === expected[f].toString(), '');
    }
    if (!f.startsWith('zdotdir/')) {
      const file = path.join(SHIM(), f);
      fs.chmodSync(file, 0o600);
      const repaired = agentEnv();
      ok(`reinstallation restores executable mode of ${f}`, repaired.status === 0 && (fs.statSync(file).mode & 0o100) !== 0, '');
    }
  }

  // Re-read the saved environment after a launcher disappears; && must stop
  // the caller before it can perform a command under an incomplete identity.
  fs.rmSync(path.join(SHIM(), 'bin', 'mm-gh-org'));
  fs.writeFileSync(curlLog, ''); fs.writeFileSync(ghLog, '');
  const missing = run(['-c', 'source "$1" && echo accepted', '_', path.join(DIR, 'env')]);
  ok('saved environment refuses a missing mm-gh-org before any mint/gh/caller command',
    missing.status !== 0 && !missing.stdout.includes('accepted') && records(curlLog).length === 0 && ghRuns().length === 0, '');
  agentEnv();

  fs.writeFileSync(scenarioFile, JSON.stringify({
    [`GET ${API}/orgs/${ORG}/installation`]: { status: 200, body: { id: 42 } },
    [`GET ${API}/orgs/ThruuAi/installation`]: { status: 200, body: { id: 43 } },
    [`POST ${API}/app/installations/42/access_tokens`]: minted('ghs_LIFECYCLE_MARVINA'),
    [`POST ${API}/app/installations/43/access_tokens`]: minted('ghs_LIFECYCLE_THRUU'),
  }));
  for (const f of [CACHE, `${CACHE}.thruuai`]) fs.rmSync(f, { force: true });
  const printed = agentEnv().stdout;
  const secrets = ['ghs_LIFECYCLE_MARVINA', 'ghs_LIFECYCLE_THRUU', OWNER, PKG];
  for (const org of ['marvinamiranda', 'ThruuAi']) {
    fs.writeFileSync(ghLog, '');
    const routed = inChild(printed, `mm-gh-org ${org} api route`, { FAKE_REAL_GH_EXIT: '37' });
    const runs = ghRuns();
    const token = org === 'ThruuAi' ? secrets[1] : secrets[0];
    ok(`named ${org} gets its distinct installation token in gh environment and preserves exit 37`,
      routed.status === 37 && runs.length === 1 && runs[0].token === token && runs[0].args.join(' ') === 'api route', '');
    ok(`named ${org} token is absent from gh/curl argv and raw stdout/stderr`,
      !secrets.some((t) => (routed.stdout + routed.stderr).includes(t))
        && runs.every((c) => !secrets.some((t) => c.args.join(' ').includes(t)))
        && records(curlLog).every((c) => !/ghs_|eyJ/.test(c.argv.join(' '))), '');
  }
  for (const arg of ['', 'OtherOrg', 'ThruuAi/extra', 'thruuai']) {
    for (const f of [CACHE, `${CACHE}.thruuai`]) fs.rmSync(f, { force: true });
    fs.writeFileSync(curlLog, ''); fs.writeFileSync(ghLog, '');
    const refused = inChild(printed, `mm-gh-org ${arg ? JSON.stringify(arg) : ''}`);
    ok(`missing/unknown org ${JSON.stringify(arg)} refuses with zero mint/API/gh and no sentinel output`,
      refused.status === 2 && records(curlLog).length === 0 && ghRuns().length === 0
        && !secrets.some((t) => (refused.stdout + refused.stderr).includes(t)), '');
  }

  // Atomic replacement failure must print the existing locked environment,
  // never a success environment; the stamp is left behind but cannot hide it.
  const target = path.join(SHIM(), 'bin', 'mm-gh-org');
  fs.appendFileSync(target, '\n# corrupted for interrupted copy\n');
  const stamp = readOr(path.join(SHIM(), '.installed'));
  const mv = path.join(stubBin, 'mv');
  fs.writeFileSync(mv, `#!/usr/bin/env bash\nfor last; do :; done\nif [ "$last" = ${JSON.stringify(target)} ]; then exit 74; fi\nexec /bin/mv "$@"\n`, { mode: 0o755 });
  const interrupted = agentEnv();
  fs.rmSync(mv);
  fs.writeFileSync(curlLog, ''); fs.writeFileSync(ghLog, '');
  const locked = inChild(interrupted.stdout, 'gh api forbidden; echo "gh-rc=$?"');
  ok('failed atomic launcher replacement emits a locked failing environment and leaves the stamp unchanged',
    interrupted.status !== 0 && /eval-rc=1/.test(locked.stderr) && rcOf(locked.stdout, 'gh-rc') !== 0
      && ghRuns().length === 0 && readOr(path.join(SHIM(), '.installed')) === stamp, `installer=${interrupted.status}`);
  ok('failed installation raw output leaks no sentinel credentials',
    !secrets.some((t) => (interrupted.stdout + interrupted.stderr + locked.stdout + locked.stderr).includes(t)), '');
  const recovered = agentEnv();
  ok('a later reinstall recovers the interrupted artifact to canonical bytes',
    recovered.status === 0 && fs.readFileSync(target).equals(expected['bin/mm-gh-org']), '');
})();

// --------------------------------------------------- agent-env.sh (B1) ----
(function prints() {
  fresh({ tokens: ['ghs_SECRET1'] });
  const r = agentEnv();
  ok('agent-env.sh succeeds with a working App', r.status === 0, r.stderr.trim());
  ok('the printed environment holds no token', !r.stdout.includes('ghs_SECRET1'),
    r.stdout.split('\n').find((l) => l.includes('ghs_SECRET1')));

  const owner = { GH_TOKEN: OWNER, GITHUB_TOKEN: OWNER, GH_PACKAGES_TOKEN: OWNER };
  const printed = agentEnv(owner).stdout;
  const u = inChild(printed, 'echo "${GH_TOKEN-unset}/${GITHUB_TOKEN-unset}/${GH_PACKAGES_TOKEN-unset}"', owner);
  const [tok, ghub, pkg] = u.stdout.trim().split('/');
  ok('tokens inherited from the owner do not survive: GH_TOKEN is the sentinel, GITHUB_TOKEN and GH_PACKAGES_TOKEN are unset',
    SENTINEL_RE.test(tok) && ghub === 'unset' && pkg === 'unset', u.stdout.trim());

  // R1: a real gh reached some other way (PATH order, not an absolute path)
  // answers `gh auth token` with GH_TOKEN, so it hands out the sentinel.
  fs.writeFileSync(brewLog, '');
  const b = inChild(printed, `PATH=${JSON.stringify(brewBin)}:"$PATH" gh auth token`, owner);
  ok('a real gh reached through PATH order answers gh auth token with the sentinel, not the keyring login',
    SENTINEL_RE.test(b.stdout.trim()) && !b.stdout.includes(OWNER), b.stdout.trim());

  const w = inChild(printed, 'command -v gh');
  ok('a grandchild process resolves gh to the shim, not the real gh',
    w.stdout.trim().startsWith(`${DIR}/`) && w.stdout.trim() !== REAL_GH, w.stdout.trim() || w.stderr.trim());
  const real = inChild(printed, 'printf "real-gh=%s\\n" "$MM_REAL_GH_BIN"');
  ok('agent-env exports the absolute real gh path it found before installing the shim',
    field(real.stdout, 'real-gh') === REAL_GH_CANON, real.stdout.trim());

  const old = run(['-c', 'gh() { echo OLD; }; eval "$1"; type -t gh', '_', printed]);
  ok('a gh() function left by an older agent-env.sh is replaced by the shim', old.stdout.trim() === 'file', old.stdout.trim());

  // zsh parses a whole eval before running it, with aliases expanded, so an
  // alias named gh is checked for too (as is one in an interactive bash).
  if (zshOrSkip('the printed environment evaluates under zsh with an alias named gh')) {
    const z = spawnSync('zsh', ['-c', 'alias gh="echo ALIAS"; eval "$1" && command -v gh', '_', printed], { env: env(), encoding: 'utf8' });
    ok('the printed environment also evaluates under zsh, with an alias named gh', z.status === 0 && z.stdout.trim().startsWith(`${DIR}/`), (z.stdout + z.stderr).trim());
  }
})();

// ---------------------------- post-review.sh uses the Reviewer App identity ----
(function postReviewUsesReviewerIdentity() {
  fresh();
  fs.writeFileSync(path.join(DIR, 'bot-id'), '99\n');
  writeCache({ token: 'ghs_AGENT_FIXTURE' });
  writeReviewerFixture();
  agentEnv(); // installs the fake identity shim that the external PATH link targets
  const agentShim = path.join(SHIM(), 'bin', 'gh');
  const linkedBin = path.join(root, 'linked-bin');
  fs.mkdirSync(linkedBin);
  fs.symlinkSync(agentShim, path.join(linkedBin, 'gh'));
  const discovery = agentEnv({ PATH: [stubBin, linkedBin, realBin, path.dirname(process.execPath), SYS_PATH].join(':') });
  const printed = discovery.stdout;
  const discoveredPath = inChild(printed, 'printf "real-gh=%s\\n" "$MM_REAL_GH_BIN"');
  ok('agent-env skips an external PATH symlink whose target is inside mm-agent',
    discovery.status === 0 && field(discoveredPath.stdout, 'real-gh') === REAL_GH_CANON,
    `status=${discovery.status}; discovered=${field(discoveredPath.stdout, 'real-gh')}`);
  const post = `${JSON.stringify(POST_REVIEW)} marvinamiranda/omni237 ${REVIEW_SHA} success ${JSON.stringify('fixture review')}`;
  const before = records(curlLog).length;
  fs.writeFileSync(ghLog, '');

  const inheritedEnterprise = {
    GH_HOST: 'example.invalid',
    GH_ENTERPRISE_TOKEN: 'fake-enterprise-owner-fixture',
    GITHUB_ENTERPRISE_TOKEN: 'fake-github-enterprise-owner-fixture',
  };
  const result = inChild(printed, `printf 'shim=%s\\n' "$(command -v gh)"; printf 'real=%s\\n' "$MM_REAL_GH_BIN"; ${post}`, inheritedEnterprise);
  const calls = ghRuns();
  const call = calls[0];
  let payload = null;
  try { payload = call ? JSON.parse(call.input) : null; } catch {}
  ok('post-review succeeds with the mm-agent shim first on PATH',
    result.status === 0 && field(result.stdout, 'shim') === agentShim && field(result.stdout, 'real') === REAL_GH_CANON
      && calls.length === 1 && call.args[0] === 'api' && call.args.includes('repos/marvinamiranda/omni237/check-runs')
      && call.args.includes('--hostname') && call.args[call.args.indexOf('--hostname') + 1] === 'github.com',
    `status=${result.status}; shim=${field(result.stdout, 'shim')}; real=${field(result.stdout, 'real')}; calls=${calls.length}`);
  ok('post-review sends the exact independent check name and head SHA',
    payload?.name === 'review/independent' && payload.head_sha === REVIEW_SHA
      && payload.status === 'completed' && payload.conclusion === 'success',
    payload ? JSON.stringify(payload) : 'no check payload recorded');
  ok('post-review passes the cached mm-reviewer fixture token directly to real gh',
    call?.token === 'ghs_REVIEWER_FIXTURE' && call.config === path.join(DIR, 'gh')
      && call.ghHost === null && call.enterpriseToken === null && call.githubEnterpriseToken === null,
    `reviewer-token=${call?.token === 'ghs_REVIEWER_FIXTURE' ? 'yes' : 'no'}; isolated-config=${call?.config === path.join(DIR, 'gh')}`);
  ok('the fixture token is never printed and the helper makes no API calls',
    !result.stdout.includes('ghs_REVIEWER_FIXTURE') && !result.stderr.includes('ghs_REVIEWER_FIXTURE')
      && before === 0 && records(curlLog).length === before,
    `stdout-has-token=${result.stdout.includes('ghs_REVIEWER_FIXTURE')}; stderr-has-token=${result.stderr.includes('ghs_REVIEWER_FIXTURE')}; calls-before=${before}; calls-after=${records(curlLog).length}`);

  fs.writeFileSync(ghLog, '');
  const absent = inChild(printed, `unset MM_REAL_GH_BIN; ${post}`);
  ok('post-review fails closed without the discovered real gh path instead of using PATH',
    absent.status !== 0 && ghRuns().length === 0 && records(curlLog).length === before,
    `status=${absent.status}; real-gh-runs=${ghRuns().length}; fake-api-calls=${records(curlLog).length - before}`);

  const shimPath = `MM_REAL_GH_BIN=${JSON.stringify(agentShim)}; export MM_REAL_GH_BIN; ${post}`;
  const shim = inChild(printed, shimPath);
  ok('post-review rejects an identity shim passed as the real gh path',
    shim.status !== 0 && ghRuns().length === 0 && records(curlLog).length === before,
    `status=${shim.status}; real-gh-runs=${ghRuns().length}; fake-api-calls=${records(curlLog).length - before}`);

  const linkedGh = path.join(root, 'external-real-gh-link');
  fs.symlinkSync(agentShim, linkedGh);
  const linkedPath = `MM_REAL_GH_BIN=${JSON.stringify(linkedGh)}; export MM_REAL_GH_BIN; ${post}`;
  const linked = inChild(printed, linkedPath);
  ok('post-review rejects an external executable symlink resolving into mm-agent',
    linked.status !== 0 && ghRuns().length === 0 && records(curlLog).length === before,
    `status=${linked.status}; real-gh-runs=${ghRuns().length}; fake-api-calls=${records(curlLog).length - before}`);

  const ownerConfig = `GH_CONFIG_DIR=${JSON.stringify(path.join(home, '.config', 'gh'))}; export GH_CONFIG_DIR; ${post}`;
  const config = inChild(printed, ownerConfig);
  ok('post-review rejects an owner gh config that could supply a fallback login',
    config.status !== 0 && ghRuns().length === 0 && records(curlLog).length === before,
    `status=${config.status}; real-gh-runs=${ghRuns().length}; fake-api-calls=${records(curlLog).length - before}`);

  fs.rmSync(agentShim, { force: true });
  const missingShim = inChild(printed,
    `source ${JSON.stringify(path.join(DIR, 'env'))}; printf 'real-gh=%s\\n' "\${MM_REAL_GH_BIN-unset}"`);
  ok('the installed environment clears MM_REAL_GH_BIN when its shim is missing',
    field(missingShim.stdout, 'real-gh') === 'unset', missingShim.stdout.trim());
})();

// ------------------------------------ R1: zsh login and interactive shells ----
// Claude Code builds its tool shells from a login, interactive zsh; the
// owner's .zprofile runs `brew shellenv`, which puts the real gh first again.
(function zshStartup() {
  if (!zshOrSkip('zsh login and interactive shells keep the shim first')) return;
  const probe = [
    'print -r -- "gh=$(command -v gh)"',
    'print -r -- "token=${GH_TOKEN-unset}"',
    'print -r -- "packages=${GH_PACKAGES_TOKEN-unset}"',
    'print -r -- "owner-files=${OWNER_ZSHENV-}${OWNER_ZPROFILE-}${OWNER_ZSHRC-}${OWNER_ZLOGIN-}"',
    'print -r -- "owner-saw-zdotdir=${OWNER_SAW_ZDOTDIR-}"',
    'print -r -- "histfile=${HISTFILE-}"',
    `print -r -- "brew-token=$(${JSON.stringify(path.join(brewBin, 'gh'))} auth token)"`,
    'gh auth token; print -r -- "gh-rc=$?"',
    'print -r -- "nested=$(zsh -lic \'command -v gh\' 2>/dev/null)"',
  ].join('; ');
  for (const [flags, files, withPackages] of [
    ['-lc', 'epl', false], ['-lic', 'eprl', false], ['-ic', 'er', false],
    ['-lc', 'epl', true], ['-lic', 'eprl', true], ['-ic', 'er', true],
  ]) {
    fresh();
    if (withPackages) fs.writeFileSync(PACKAGES, `${PKG}\n`, { mode: 0o600 });
    const owner = { GH_TOKEN: OWNER, GITHUB_TOKEN: OWNER, GH_PACKAGES_TOKEN: OWNER };
    const printed = agentEnv(owner).stdout;
    const z = inZsh(printed, flags, probe, owner);
    const out = z.stdout;
    const shimGh = path.join(SHIM(), 'bin', 'gh');
    const label = `zsh ${flags}${withPackages ? ', with a packages token' : ''}`;
    ok(`${label}: gh is the shim, though the owner's startup files put another gh first`,
      field(out, 'gh') === shimGh, `${field(out, 'gh')} ${z.stderr.trim().split('\n').slice(-2).join(' | ')}`);
    ok(`${label}: the owner's startup files still ran, with ZDOTDIR set to their own directory`,
      field(out, 'owner-files') === files && field(out, 'owner-saw-zdotdir') === home, `${field(out, 'owner-files')} saw ${field(out, 'owner-saw-zdotdir')}`);
    ok(`${label}: gh auth token is refused, GH_TOKEN is still the sentinel, and a real gh by path answers with the sentinel`,
      rcOf(out, 'gh-rc') !== 0 && /refused/.test(z.stderr) && SENTINEL_RE.test(field(out, 'token') || '')
        && SENTINEL_RE.test(field(out, 'brew-token') || ''), `rc=${rcOf(out, 'gh-rc')} token=${field(out, 'token')} brew=${field(out, 'brew-token')}`);
    ok(`${label}: GH_PACKAGES_TOKEN is what agent-env.sh set, not what the owner's .zshrc made of gh auth token`,
      field(out, 'packages') === (withPackages ? PKG : 'unset'), field(out, 'packages'));
    ok(`${label}: no zsh started inside it gets the owner's gh, and the owner's token appears nowhere`,
      field(out, 'nested') === shimGh && !out.includes(OWNER), `nested=${field(out, 'nested')}`);
    ok(`${label}: the history file stays where the owner's is`,
      !(field(out, 'histfile') || '').startsWith(path.join(DIR, 'shim')), field(out, 'histfile'));
  }
})();

// ------------------------------------------------------ refusals (B1, R3) ----
(function refusals() {
  fresh();
  const printed = agentEnv().stdout;
  for (const [what, cmd] of [
    ['gh auth token', 'gh auth token'],
    ['gh auth token --user <owner> (reads the keyring whatever GH_TOKEN says)', 'gh auth token --user rodrigolmiranda'],
    ['gh auth status --show-token', 'gh auth status --show-token'],
    ['gh auth status -t', 'gh auth status -t'],
    ['gh auth git-credential', 'echo | gh auth git-credential get'],
    ['gh auth login', 'gh auth login --with-token </dev/null'],
    ['gh auth setup-git', 'gh auth setup-git'],
    ['gh alias set (could name a refused command)', 'gh alias set tk "auth token"'],
    ['gh alias import', 'echo "tk: auth token" | gh alias import -'],
    // R3: a flag ahead of the command hides it from a check of $1 alone.
    ['gh --help=false auth token (a flag ahead of the command)', 'gh --help=false auth token'],
    ['gh --help=false auth token --user <owner>', 'gh --help=false auth token --user rodrigolmiranda'],
    ['gh --help=false alias set', 'gh --help=false alias set tk "auth token"'],
    ['gh --version=false auth token', 'gh --version=false auth token'],
    ['gh -- auth token', 'gh -- auth token'],
    ['gh --help auth token (a root flag, but not on its own)', 'gh --help auth token'],
    ['gh alias --help=false set (a flag ahead of the subcommand)', 'gh alias --help=false set tk "auth token"'],
  ]) {
    fs.writeFileSync(ghLog, '');
    const r = inChild(printed, `${cmd}; echo "gh-rc=$?"`);
    ok(`${what} is refused in a grandchild and never reaches the real gh`,
      rcOf(r.stdout, 'gh-rc') !== 0 && /refused/.test(r.stderr) && ghRuns().length === 0,
      `rc=${rcOf(r.stdout, 'gh-rc')} real-gh=${JSON.stringify(ghRuns().map((g) => g.args))} ${r.stderr.trim().split('\n').pop()}`);
  }
  for (const [what, cmd, args] of [
    ['a plain gh auth status', 'gh auth status', 'auth status'],
    ['gh --help on its own', 'gh --help', '--help'],
    ['gh -h on its own', 'gh -h', '-h'],
    ['gh --version on its own', 'gh --version', '--version'],
    ['gh alias list', 'gh alias list', 'alias list'],
    ['a flag after the command (gh pr list --state open)', 'gh pr list --state open', 'pr list --state open'],
  ]) {
    fs.writeFileSync(ghLog, '');
    const s = inChild(printed, `${cmd}; echo "gh-rc=$?"`);
    ok(`${what} still runs`, rcOf(s.stdout, 'gh-rc') === 0 && ghRuns().length === 1 && ghRuns()[0].args.join(' ') === args,
      `${JSON.stringify(ghRuns().map((g) => g.args))} ${s.stderr.trim()}`);
  }
})();

(function mintsPerCall() {
  fresh({ tokens: ['ghs_T1', 'ghs_T2'] });
  const printed = agentEnv().stdout;
  fs.writeFileSync(ghLog, '');
  // Two gh calls in ONE grandchild; between them the cached token turns five
  // minutes old, as it does in a session that outlives it.
  const age = `printf '%s %s\\n%s\\n' "$(( $(date +%s) + 3000 ))" ghs_T1 "$(( $(date +%s) - 301 ))" > ${JSON.stringify(CACHE)}`;
  const r = inChild(printed, `gh api first; ${age}; gh api second`);
  const runs = ghRuns();
  ok('gh runs with a minted App token and the identity\'s empty GH_CONFIG_DIR',
    runs[0] && runs[0].token === 'ghs_T1' && runs[0].config === path.join(DIR, 'gh') && runs[0].args.join(' ') === 'api first',
    JSON.stringify(runs[0]) + r.stderr.trim());
  ok('a long-lived grandchild gets a re-minted token once the cached one is 5 minutes old',
    runs[1] && runs[1].token === 'ghs_T2', JSON.stringify(runs[1]));

  const g = inChild(printed, CRED);
  ok('git gets an App token from the credential helper',
    /username=x-access-token/.test(g.stdout) && /password=ghs_T2/.test(g.stdout) && rcOf(g.stdout, 'git-rc') === 0,
    (g.stdout + g.stderr).trim());

  // Two orgs: the helper takes the org from the path git sends (useHttpPath).
  fs.writeFileSync(scenarioFile, JSON.stringify({
    [`GET ${API}/orgs/${ORG}/installation`]: { status: 200, body: { id: 42 } },
    [`GET ${API}/orgs/ThruuAi/installation`]: { status: 200, body: { id: 43 } },
    [`POST ${API}/app/installations/42/access_tokens`]: minted('ghs_MARVINA'),
    [`POST ${API}/app/installations/43/access_tokens`]: minted('ghs_THRUU'),
  }));
  fs.rmSync(CACHE, { force: true });
  fs.rmSync(`${CACHE}.thruuai`, { force: true });
  const credFor = (p) => inChild(printed, `printf "protocol=https\\nhost=github.com\\npath=${p}\\n\\n" | git credential fill`);
  const t = credFor('ThruuAi/sm360wf.git');
  const m = credFor('marvinamiranda/omni237.git');
  ok('the helper gives a ThruuAi path the ThruuAi token', /password=ghs_THRUU/.test(t.stdout), (t.stdout + t.stderr).trim());
  ok('the helper gives any other path the marvinamiranda token', /password=ghs_MARVINA/.test(m.stdout), (m.stdout + m.stderr).trim());
  inChild(printed, 'gh api plain', { ORG: 'ThruuAi', MM_GH_ORG: 'ThruuAi' });
  ok('plain gh ignores an ambient ORG / MM_GH_ORG: marvinamiranda token', ghRuns().pop().token === 'ghs_MARVINA', JSON.stringify(ghRuns().slice(-1)));
  const bad = inChild(printed, 'mm-gh-org OtherOrg api x; echo "rc=$?"');
  ok('mm-gh-org refuses an org outside the allowlist', /rc=2/.test(bad.stdout) && !/OtherOrg/.test(bad.stdout + bad.stderr.replace(/usage[^\n]*/g, '')), bad.stdout + bad.stderr);
  const wrapped = inChild(printed, 'mm-gh-org ThruuAi api x');
  const wr = ghRuns().pop();
  ok('mm-gh-org <org> runs gh with that org\'s token', wr && wr.token === 'ghs_THRUU' && wr.args.join(' ') === 'api x', JSON.stringify(wr) + wrapped.stderr.trim());
})();

(function failsClosed() {
  for (const [what, broken] of [
    ['no token can be minted (installation gone)', { installation: { status: 404, body: { message: 'Not Found' } } }],
    ['the minted token is empty', { tokens: [{ status: 201, body: { token: '', expires_at: iso(now() + 3600) } }] }],
    ['the minted token is not an installation token', { tokens: ['gho_NOTANAPPTOKEN'] }],
  ]) {
    fresh();
    const printed = agentEnv().stdout; // set up while the App works
    world(broken); // then the App breaks, and the cached token is gone
    fs.rmSync(CACHE, { force: true });
    const r = inChild(printed, 'gh api user; echo "gh-rc=$?"');
    ok(`gh fails closed when ${what}`, rcOf(r.stdout, 'gh-rc') !== 0 && ghRuns().length === 0,
      `rc=${rcOf(r.stdout, 'gh-rc')} real-gh=${JSON.stringify(ghRuns())}`);
    const g = inChild(printed, CRED);
    ok(`git fails closed when ${what}`, rcOf(g.stdout, 'git-rc') !== 0 && !/password=./.test(g.stdout),
      (g.stdout + g.stderr).trim().split('\n').slice(-3).join(' | '));
  }
})();

(function lockedOnFailure() {
  const owner = { GH_TOKEN: OWNER, GITHUB_TOKEN: OWNER, GH_PACKAGES_TOKEN: OWNER };
  const repo = path.join(root, 'repo');
  spawnSync('git', ['init', '-q', repo]);
  const COMMIT_CMD = `git -C ${JSON.stringify(repo)} -c user.name=Owner -c user.email=owner@example.com commit -q --allow-empty -m x; echo "commit-rc=$?"`;
  for (const [what, setup, name] of [
    ['its gh directory holds a login (hosts.yml)', () => { fs.mkdirSync(path.join(DIR, 'gh'), { recursive: true }); fs.writeFileSync(path.join(DIR, 'gh', 'hosts.yml'), 'github.com: {}\n'); }, NAME],
    ['the App was never created (no app.json)', () => fs.rmSync(path.join(DIR, 'app.json')), NAME],
    ['the identity is unknown', () => {}, 'mm-nobody'],
  ]) {
    fresh();
    setup();
    const r = agentEnv(owner, name);
    ok(`agent-env.sh exits non-zero when ${what}`, r.status !== 0, `status ${r.status}`);
    const c = inChild(r.stdout, `echo "tokens=\${GH_TOKEN-unset}/\${GITHUB_TOKEN-unset}/\${GH_PACKAGES_TOKEN-unset}"; echo "real-gh=\${MM_REAL_GH_BIN-unset}"; gh api user; echo "gh-rc=$?"; ${CRED}; ${COMMIT_CMD}`, owner);
    const toks = (field(c.stdout, 'tokens') || '').split('/');
    ok(`...and what it printed leaves no identity: the sentinel, gh, git and commits refuse, the eval fails (${what})`,
      SENTINEL_RE.test(toks[0] || '') && toks[1] === 'unset' && toks[2] === 'unset'
        && field(c.stdout, 'real-gh') === 'unset'
        && rcOf(c.stdout, 'gh-rc') !== 0 && ghRuns().length === 0
        && rcOf(c.stdout, 'git-rc') !== 0 && !/password=./.test(c.stdout) && rcOf(c.stdout, 'commit-rc') !== 0
        && rcOf(c.stderr, 'eval-rc') !== 0,
      `${c.stdout.trim().split('\n').join(' | ')} || eval-rc=${rcOf(c.stderr, 'eval-rc')}`);
  }

  // The same, where the shell has an alias named gh.
  fresh();
  fs.rmSync(path.join(DIR, 'app.json'));
  const printed = agentEnv(owner).stdout;
  const probe = 'echo "tokens=${GH_TOKEN-unset}/${GH_PACKAGES_TOKEN-unset}"; eval "gh api user"; echo "gh-rc=$?"';
  for (const [shell, args] of [
    ['zsh', ['-c', `alias gh="echo ALIAS"; eval "$1"; echo "eval-rc=$?"; ${probe}`, '_', printed]],
    ['bash (aliases on, as when interactive)', ['-c', `shopt -s expand_aliases; alias gh="echo ALIAS"; eval "$1"; echo "eval-rc=$?"; ${probe}`, '_', printed]],
  ]) {
    const bin = shell.startsWith('zsh') ? 'zsh' : BASH;
    if (bin === 'zsh' && !zshOrSkip('a failed run under zsh with an alias named gh')) continue;
    const a = spawnSync(bin, args, { env: env(owner), encoding: 'utf8' });
    const t = (field(a.stdout, 'tokens') || '').split('/');
    ok(`under ${shell} with an alias named gh, what a failed run printed still leaves no identity`,
      SENTINEL_RE.test(t[0] || '') && t[1] === 'unset' && rcOf(a.stdout, 'gh-rc') !== 0 && rcOf(a.stdout, 'eval-rc') !== 0 && !/ALIAS/.test(a.stdout),
      (a.stdout + a.stderr).trim().split('\n').join(' | '));
  }

  // R1 for the no-identity environment: a zsh login shell keeps its refusing gh first.
  if (zshOrSkip('a failed run keeps its refusing gh first in a zsh login shell')) {
    fs.writeFileSync(ghLog, '');
    const z = inZsh(printed, '-lic', `print -r -- "gh=$(command -v gh)"; gh api user; print -r -- "gh-rc=$?"; print -r -- "brew-token=$(${JSON.stringify(path.join(brewBin, 'gh'))} auth token)"`, owner);
    ok('a failed run keeps its refusing gh first in a zsh login shell, and a real gh by path answers with the sentinel',
      field(z.stdout, 'gh') === path.join(ROOT, 'locked', 'bin', 'gh') && rcOf(z.stdout, 'gh-rc') !== 0 && ghRuns().length === 0
        && SENTINEL_RE.test(field(z.stdout, 'brew-token') || ''),
      `${z.stdout.trim().split('\n').join(' | ')} ${z.stderr.trim().split('\n').slice(-1)}`);
  }
})();

// ------------------------------------------ R6: GH_PACKAGES_TOKEN from a file ----
(function packagesToken() {
  const owner = { GH_TOKEN: OWNER, GITHUB_TOKEN: OWNER, GH_PACKAGES_TOKEN: OWNER };
  const other = path.join(root, 'elsewhere-token');
  for (const [what, setup, exported] of [
    ['a 0600 file holding a classic token', () => fs.writeFileSync(PACKAGES, `${PKG}\n`, { mode: 0o600 }), true],
    ['no file', () => {}, false],
    ['a world-readable file (0644)', () => { fs.writeFileSync(PACKAGES, `${PKG}\n`); fs.chmodSync(PACKAGES, 0o644); }, false],
    ['a group-readable file (0640)', () => { fs.writeFileSync(PACKAGES, `${PKG}\n`); fs.chmodSync(PACKAGES, 0o640); }, false],
    ['a file holding a gh login token (gho_), not a classic token', () => fs.writeFileSync(PACKAGES, `${OWNER}\n`, { mode: 0o600 }), false],
    ['a file holding two lines', () => fs.writeFileSync(PACKAGES, `${PKG}\n${PKG}\n`, { mode: 0o600 }), false],
    ['a symbolic link to a 0600 file', () => { fs.writeFileSync(other, `${PKG}\n`, { mode: 0o600 }); fs.symlinkSync(other, PACKAGES); }, false],
  ]) {
    fresh();
    fs.rmSync(other, { force: true });
    setup();
    const r = agentEnv(owner);
    const c = inChild(r.stdout, 'echo "packages=${GH_PACKAGES_TOKEN-unset}"', owner);
    const hint = r.stderr.split('\n').filter((l) => /GH_PACKAGES_TOKEN/.test(l));
    ok(`packages token, ${what}: agent-env.sh succeeds and never prints the token`,
      r.status === 0 && !r.stdout.includes(PKG) && !r.stderr.includes(PKG), `status ${r.status}`);
    ok(exported ? `packages token, ${what}: exported as GH_PACKAGES_TOKEN, with no hint`
      : `packages token, ${what}: GH_PACKAGES_TOKEN is unset, with a one-line hint`,
    exported ? field(c.stdout, 'packages') === PKG && hint.length === 0
      : field(c.stdout, 'packages') === 'unset' && hint.length === 1,
    `packages=${field(c.stdout, 'packages')} hint=${JSON.stringify(hint)}`);
  }
  fs.rmSync(other, { force: true });
})();

// --------------------------------- the launcher runs copies, not the checkout ----
(function launcher() {
  fresh();
  canonTest('head');
  const printed = agentEnv().stdout;
  const shim = SHIM();
  const launcherText = readOr(path.join(shim, 'bin', 'gh'));
  ok('the launcher runs copies kept under ~/.config/mm-agent/<name>/shim/<commit>/, not the checkout',
    launcherText.includes(path.join(shim, 'libexec', 'gh-shim.sh')) && !launcherText.includes(src), launcherText.trim());
  ok('the copies are exactly the committed gh-shim.sh and app-token.sh',
    ['gh-shim.sh', 'app-token.sh'].every((f) => readOr(path.join(shim, 'libexec', f), null)
      === git(src, 'show', `HEAD:governance/identity/${f}`) + '\n'), listOr(path.join(shim, 'libexec')).join(','));
  ok('the helpers are not on PATH: only gh and the mm-gh-org launcher are in the directory PATH gets',
    listOr(path.join(shim, 'bin')).join(',') === 'gh,mm-gh-org', listOr(path.join(shim, 'bin')).join(','));
  const helper = inChild(printed, 'git config --get-all credential.https://github.com.helper | tail -1');
  ok('the git credential helper also runs the copy', helper.stdout.includes(path.join(shim, 'libexec', 'app-token.sh')) && !helper.stdout.includes(src), helper.stdout.trim());

  // The checkout changes under a running session: it keeps its copies.
  const shimFile = path.join(IDENTITY, 'gh-shim.sh');
  const original = fs.readFileSync(shimFile);
  fs.writeFileSync(shimFile, '#!/usr/bin/env bash\nREAL="$2"; shift 2; exec "$REAL" "$@"\n');
  fs.writeFileSync(ghLog, '');
  let t = inChild(printed, 'gh auth token; echo "gh-rc=$?"');
  ok('a checkout that changes after the eval does not change the session: gh auth token is still refused',
    rcOf(t.stdout, 'gh-rc') !== 0 && ghRuns().length === 0, `rc=${rcOf(t.stdout, 'gh-rc')} ${JSON.stringify(ghRuns())}`);
  fs.writeFileSync(shimFile, original);

  fs.renameSync(src, `${src}.moved`);
  fs.writeFileSync(ghLog, '');
  t = inChild(printed, 'gh api user; echo "gh-rc=$?"');
  fs.renameSync(`${src}.moved`, src);
  ok('a checkout that is gone after the eval leaves the session working', rcOf(t.stdout, 'gh-rc') === 0 && ghRuns().length === 1,
    `${t.stdout.trim()} ${t.stderr.trim()}`);
})();

// ------------------------------------------- a dirty source is refused ----
(function dirtySource() {
  const rel = (f) => `governance/identity/${f}`;
  for (const [what, dirty] of [
    ['an uncommitted change to gh-shim.sh', () => fs.appendFileSync(path.join(IDENTITY, 'gh-shim.sh'), '# local\n')],
    ['an uncommitted change to app-token.sh', () => fs.appendFileSync(path.join(IDENTITY, 'app-token.sh'), '# local\n')],
    ['an uncommitted change to agent-env.sh', () => fs.appendFileSync(path.join(IDENTITY, 'agent-env.sh'), '# local\n')],
    ['a change hidden by git update-index --assume-unchanged', () => {
      git(src, 'update-index', '--assume-unchanged', rel('gh-shim.sh'));
      fs.appendFileSync(path.join(IDENTITY, 'gh-shim.sh'), '# hidden\n');
    }],
  ]) {
    fresh();
    dirty();
    const r = agentEnv();
    fs.writeFileSync(ghLog, '');
    const c = inChild(r.stdout, 'gh api user; echo "gh-rc=$?"');
    ok(`agent-env.sh refuses ${what}, installs nothing, and what it printed leaves no identity`,
      r.status !== 0 && /differs from commit/.test(c.stderr) && rcOf(c.stdout, 'gh-rc') !== 0 && ghRuns().length === 0
        && !fs.existsSync(path.join(DIR, 'shim')),
      `status ${r.status} ${c.stderr.trim().split('\n').slice(0, 2).join(' | ')}`);
    git(src, 'update-index', '--no-assume-unchanged', rel('gh-shim.sh'));
    git(src, 'checkout', '-q', '--', '.');
  }

  fresh();
  const loose = fs.mkdtempSync(path.join(root, 'loose-'));
  for (const f of SCRIPTS) fs.copyFileSync(path.join(IDENTITY, f), path.join(loose, f));
  const r = agentEnv({}, NAME, loose);
  const c = inChild(r.stdout, 'gh api user; echo "gh-rc=$?"');
  ok('agent-env.sh refuses to run from files outside a git checkout', r.status !== 0 && /not in a git checkout/.test(c.stderr)
    && rcOf(c.stdout, 'gh-rc') !== 0, `status ${r.status} ${c.stderr.trim().split('\n')[0]}`);
})();

// ------------------------------------ provenance: warn when not on test ----
(function provenance() {
  const warned = (r) => r.stderr.split('\n').filter((l) => /WARNING/.test(l));
  for (const [what, where, warn] of [
    ['on test', 'head', null],
    ['older than test (test has moved on, and this checkout has not fetched it)', 'ahead', null],
    ['not on test', 'elsewhere', /not on marvinamiranda\/\.github test/],
    ['unknown, because test cannot be read', 'gone', /could not be read/],
  ]) {
    fresh();
    canonTest(where);
    const r = agentEnv();
    const w = warned(r);
    ok(warn ? `a commit ${what}: agent-env.sh warns, once, and still sets the identity`
      : `a commit ${what}: agent-env.sh sets the identity with no warning`,
    r.status === 0 && (warn ? w.length === 1 && warn.test(w[0]) : w.length === 0),
    `status ${r.status} ${JSON.stringify(w)}`);
  }
  canonTest('head');
  fresh();
  agentEnv();
  const remembered = fs.existsSync(path.join(SHIM(), 'on-test'));
  canonTest('elsewhere');
  const again = agentEnv();
  ok('a commit found on test once is remembered, and not asked about again',
    remembered && again.status === 0 && warned(again).length === 0, `remembered=${remembered} ${JSON.stringify(warned(again))}`);

  // An eval now runs only to install or refresh the identity (the per-command
  // form sources the env file), so a commit not on test is asked about again
  // at the next eval: once it is merged, that eval says nothing.
  fresh();
  canonTest('elsewhere');
  agentEnv();
  canonTest('head');
  const merged = agentEnv();
  ok('a commit not on test is asked about again at the next eval: once merged, no warning',
    merged.status === 0 && warned(merged).length === 0, JSON.stringify(warned(merged)));
  canonTest('head');
})();

// ------ marvinamiranda/.github#26: nothing under the checkout's .git decides ----
// A process that can write under .git: its config must never run in an eval
// (an agent shell's snapshot can carry the owner's token), the copies
// installed must be the working files that were checked, and "on test" must
// come from test as fetched, never from the checkout's objects.
(function gitWriter() {
  const ENV_FILE = path.join(DIR, 'env');
  const ran = path.join(root, 'agent-hook-ran.log');
  const hook = path.join(root, 'agent-hook.sh');
  fs.writeFileSync(hook, `#!/bin/sh\necho "token=\${GH_TOKEN-unset}" >> ${JSON.stringify(ran)}\n`, { mode: 0o755 });
  const attributes = path.join(src, '.git', 'info', 'attributes');
  fresh();
  canonTest('head');
  git(src, 'config', 'core.fsmonitor', hook);
  git(src, 'config', 'filter.mm.clean', `${hook}; cat`);
  fs.mkdirSync(path.dirname(attributes), { recursive: true });
  fs.writeFileSync(attributes, '* filter=mm\n');
  fs.rmSync(ran, { force: true });
  spawnSync('git', ['-C', src, 'hash-object', '--', 'governance/identity/gh-shim.sh'], { env: { ...gitEnv, GH_TOKEN: OWNER } });
  const fired = readOr(ran).includes(`token=${OWNER}`);
  fs.rmSync(ran, { force: true });
  let r = agentEnv({ GH_TOKEN: OWNER });
  const after = readOr(ran);
  git(src, 'config', '--unset', 'core.fsmonitor');
  git(src, 'config', '--remove-section', 'filter.mm');
  fs.rmSync(attributes, { force: true });
  fs.rmSync(ran, { force: true });
  ok('control: a clean filter in the checkout\'s own config runs for plain git, with the caller\'s token', fired, '');
  ok('an eval never runs a clean filter or an fsmonitor hook from the checkout\'s own config, and still sets the identity',
    r.status === 0 && after === '' && fs.existsSync(ENV_FILE), `status ${r.status} ran=${after.trim().split('\n').join(',')} ${r.stderr.trim().split('\n').slice(-1)}`);

  // A forged object filed under gh-shim.sh's blob id.
  fresh();
  canonTest('head');
  const shimBlob = git(src, 'rev-parse', 'HEAD:governance/identity/gh-shim.sh');
  const passThrough = '#!/usr/bin/env bash\nREAL="$2"; shift 2; exec "$REAL" "$@"\n';
  let restore = forgeLooseObject(src, shimBlob, 'blob', passThrough);
  const blobFooled = spawnSync('git', ['-C', src, 'cat-file', 'blob', shimBlob], { env: gitEnv, encoding: 'utf8' }).stdout === passThrough;
  r = agentEnv();
  restore();
  const installed = readOr(path.join(SHIM(), 'libexec', 'gh-shim.sh'), null);
  ok('control: the forged object gives plain git other bytes for gh-shim.sh\'s blob', blobFooled, '');
  ok('a forged object for gh-shim.sh\'s blob is not what is installed: the copy is the working file that was checked',
    r.status === 0 && installed === fs.readFileSync(path.join(IDENTITY, 'gh-shim.sh'), 'utf8'), `status ${r.status} installed=${JSON.stringify((installed || '').slice(0, 60))}`);

  // A replaced pack: the parent of test's tip filed as a forged commit whose
  // parent is the unmerged HEAD.
  fresh();
  git(src, 'commit', '-q', '--allow-empty', '-m', 'merged');
  canonTest('head');
  const tip = git(src, 'rev-parse', 'HEAD');
  execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'local, not on test'],
    { env: { ...gitEnv, ...BACKDATED } }); // older than test's tip (object-forge.js)
  const unmerged = git(src, 'rev-parse', 'HEAD');
  restore = forgePackParent(src, COMMIT, unmerged);
  const packFooled = spawnSync('git', ['-C', src, '-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', unmerged, tip],
    { env: { ...gitEnv, GIT_NO_REPLACE_OBJECTS: '1' } }).status === 0;
  r = agentEnv();
  restore();
  git(src, 'reset', '-q', '--hard', COMMIT);
  canonTest('head');
  ok('control: the replaced pack makes plain git believe the unmerged commit is on test', packFooled, '');
  ok('a replaced pack cannot make an unmerged commit "on test": the eval warns, and writes no env file',
    r.status === 0 && /not on marvinamiranda\/\.github test/.test(r.stderr) && !fs.existsSync(ENV_FILE), `status ${r.status} env=${fs.existsSync(ENV_FILE)} ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);

  // "On test" is remembered as the blob ids that were checked, so a marker
  // that names none (an older agent-env.sh's, or a planted one) is asked again.
  fresh();
  canonTest('head');
  agentEnv();
  const marker = path.join(SHIM(), 'on-test');
  const named = readOr(marker).trim().split('\n');
  fs.writeFileSync(marker, '');
  fs.rmSync(ENV_FILE, { force: true });
  canonTest('elsewhere');
  r = agentEnv();
  canonTest('head');
  ok('the remembered answer names the three blobs that were checked', named.length === 3 && named.every((l) => /^[0-9a-f]{40}$/.test(l)), JSON.stringify(named));
  ok('a remembered answer that names no blobs is not trusted: asked again, warned, no env file',
    r.status === 0 && /not on marvinamiranda\/\.github test/.test(r.stderr) && !fs.existsSync(ENV_FILE), `status ${r.status} env=${fs.existsSync(ENV_FILE)}`);
})();

// ---------------------- two sessions from two commits keep their own shims ----
(function isolation() {
  fresh();
  const printedA = agentEnv().stdout;
  fs.appendFileSync(path.join(IDENTITY, 'gh-shim.sh'), '# a later commit\n');
  git(src, 'commit', '-q', '-am', 'later');
  const B = git(src, 'rev-parse', 'HEAD');
  canonTest('head');
  const printedB = agentEnv().stdout;
  const a = inChild(printedA, 'command -v gh').stdout.trim();
  const b = inChild(printedB, 'command -v gh').stdout.trim();
  ok('two sessions evaluated from different commits each keep their own shim',
    a === path.join(SHIM(COMMIT), 'bin', 'gh') && b === path.join(SHIM(B), 'bin', 'gh'), `${a} / ${b}`);
  fs.writeFileSync(ghLog, '');
  const t = inChild(printedA, 'gh api user; echo "gh-rc=$?"');
  ok('...and the first still works after the second eval', rcOf(t.stdout, 'gh-rc') === 0 && ghRuns().length === 1, t.stderr.trim());
  git(src, 'reset', '-q', '--hard', COMMIT);
  canonTest('head');
})();

// ------------------- round 4: the per-command forms fail closed ----
// Claude Code and Codex run every tool command in a shell rebuilt from a
// snapshot of the owner's environment: the owner's gh first on PATH, no
// sentinel, the owner's token exported. Here that is `snapshot`: brew-bin's gh,
// which hands out OWNER for `gh auth token`, comes first. The command that opens
// each tool command must stop it whenever it cannot set the identity up, since
// `eval ""`, which is what a missing script leaves, succeeds.
(function perCommand() {
  const README = fs.readFileSync(process.env.IDENTITY_README ? path.resolve(process.env.IDENTITY_README)
    : path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const SHORT = '. ~/.config/mm-agent/mm-agent/env'; // exactly as the README shows it
  const LONG = (script) => `eval "$(${script} mm-agent || echo false)"`;
  const ENV_FILE = path.join(DIR, 'env');
  const snapshot = { PATH: [brewBin, stubBin, realBin, path.dirname(process.execPath), SYS_PATH].join(':'), GH_PACKAGES_TOKEN: OWNER };
  const shells = [['bash', BASH], ['zsh', 'zsh']];
  const inShell = (bin, script) => spawnSync(bin, ['-c', script], { env: env(snapshot), encoding: 'utf8', cwd: root });
  const reachedOwner = (r) => lines(brewLog).length > 0 || (r.stdout + r.stderr).includes(OWNER);

  ok('the README gives the per-command form as the guarded source of the env file, and the long form with || echo false',
    README.includes(`${SHORT} && gh`) && README.includes('agent-env.sh mm-agent || echo false)" &&')
      && !/eval "\$\([^)]*agent-env\.sh mm-agent\)" &&/.test(README), '');

  for (const [shell, bin] of shells) {
    if (shell === 'zsh' && !zshOrSkip('the per-command forms under zsh')) continue;
    for (const [what, setup, cmd] of [
      ['the long form, with the script gone', () => {}, `${LONG('/nonexistent/governance/identity/agent-env.sh')} && gh auth token`],
      ['the long form, relative, from another directory', () => {}, `cd / && ${LONG('governance/identity/agent-env.sh')} && gh auth token`],
      ['the short form, with no env file', () => {}, `${SHORT} && gh auth token`],
      ['the short form, with the shim the env file names gone', () => {
        agentEnv();
        fs.rmSync(path.join(DIR, 'shim'), { recursive: true, force: true });
      }, `${SHORT} && gh auth token`],
    ]) {
      fresh();
      setup();
      fs.writeFileSync(brewLog, '');
      fs.writeFileSync(ghLog, '');
      const r = inShell(bin, `${cmd}; echo "rc=$?"`);
      ok(`${shell}: ${what}: the command is stopped, and neither the owner's gh nor any gh runs`,
        rcOf(r.stdout, 'rc') !== 0 && !reachedOwner(r) && ghRuns().length === 0,
        `rc=${rcOf(r.stdout, 'rc')} brew=${JSON.stringify(lines(brewLog))} ${r.stderr.trim().split('\n').slice(-1)}`);
    }

    // Installed by an eval from a commit on test: the short form sets the identity up.
    fresh({ tokens: ['ghs_T1'] });
    const installed = agentEnv();
    const shimGh = path.join(SHIM(), 'bin', 'gh');
    fs.writeFileSync(brewLog, '');
    fs.writeFileSync(ghLog, '');
    let r = inShell(bin, `${SHORT} && printf 'gh=%s\\ntoken=%s\\npackages=%s\\n' "$(command -v gh)" "\${GH_TOKEN-unset}" "\${GH_PACKAGES_TOKEN-unset}" && gh auth token; echo "rc=$?"`);
    ok(`${shell}: the short form puts the shim first, sets the sentinel, drops the owner's token, and gh auth token is refused`,
      installed.status === 0 && field(r.stdout, 'gh') === shimGh && SENTINEL_RE.test(field(r.stdout, 'token') || '')
        && field(r.stdout, 'packages') === 'unset' && rcOf(r.stdout, 'rc') !== 0 && /refused/.test(r.stderr) && !reachedOwner(r) && ghRuns().length === 0,
      `${r.stdout.trim().split('\n').join(' | ')} ${r.stderr.trim().split('\n').slice(-1)}`);
    r = inShell(bin, `${SHORT} && gh api user; echo "rc=$?"`);
    ok(`${shell}: the short form's gh runs with a minted App token`,
      rcOf(r.stdout, 'rc') === 0 && ghRuns().length === 1 && ghRuns()[0].token === 'ghs_T1' && !reachedOwner(r), `${r.stderr.trim()}`);
  }

  // The env file and the printed environment set up the same thing, and hold no token.
  fresh({ tokens: ['ghs_SECRET2'] });
  fs.writeFileSync(PACKAGES, `${PKG}\n`, { mode: 0o600 });
  const printed = agentEnv().stdout;
  const envText = readOr(ENV_FILE, null);
  ok('the env file is what the eval printed, holds no token, and reads the packages token from its file',
    envText !== null && envText.trim() === printed.trim() && !envText.includes(PKG) && !envText.includes('ghs_SECRET2')
      && envText.includes(`cat -- ${PACKAGES}`), envText === null ? 'no env file' : 'differs or holds a token');
  ok('the env file is private (0600)', envText !== null && (fs.statSync(ENV_FILE).mode & 0o777) === 0o600, '');

  // Only a commit on test is installed as the env file: an eval from anywhere
  // else sets up its own shell, and leaves the env file as it was.
  fresh();
  canonTest('elsewhere');
  let e = agentEnv();
  ok('an eval from a commit not on test sets up its own shell but writes no env file, and says so',
    e.status === 0 && !fs.existsSync(ENV_FILE) && /env/.test(e.stderr) && /not updated|not written/.test(e.stderr), e.stderr.trim().split('\n').slice(-1).join(''));
  canonTest('head');

  // The short form keeps the shim of the commit installed last, whatever the
  // checkout does; the long form takes what the checkout holds now.
  fresh();
  agentEnv(); // installs COMMIT, which is on test
  fs.appendFileSync(path.join(IDENTITY, 'gh-shim.sh'), '# a later commit, not merged\n');
  git(src, 'commit', '-q', '-am', 'later, not on test');
  const later = git(src, 'rev-parse', 'HEAD');
  const longLater = agentEnv(); // the checkout's new commit: not on test
  const which = (printedOrNull) => spawnSync(BASH, ['-c', printedOrNull === null ? `${SHORT} && command -v gh` : 'eval "$1" && command -v gh', '_', printedOrNull || ''],
    { env: env(snapshot), encoding: 'utf8' }).stdout.trim();
  ok('after the checkout moves to a commit not on test, the short form still runs the installed commit, and the long form the new one',
    which(null) === path.join(SHIM(COMMIT), 'bin', 'gh') && which(longLater.stdout) === path.join(SHIM(later), 'bin', 'gh'),
    `short=${which(null)} long=${which(longLater.stdout)}`);
  fs.renameSync(src, `${src}.moved`);
  fs.writeFileSync(ghLog, '');
  const gone = spawnSync(BASH, ['-c', `${SHORT} && gh api user; echo "rc=$?"`], { env: env(snapshot), encoding: 'utf8' });
  fs.renameSync(`${src}.moved`, src);
  ok('with the checkout gone, the short form still works', rcOf(gone.stdout, 'rc') === 0 && ghRuns().length === 1, gone.stderr.trim());
  canonTest('head'); // the later commit is merged
  agentEnv();
  ok('an eval from the merged later commit moves the env file to it', which(null) === path.join(SHIM(later), 'bin', 'gh'), which(null));
  git(src, 'reset', '-q', '--hard', COMMIT);
  canonTest('head');
})();

// -------------------------------------------- app-token.sh (finding 10) ----
(function cache() {
  fresh({ tokens: ['ghs_NEW'] });
  writeCache({ token: 'ghs_CACHED', mintedAgo: 60 });
  let r = appToken();
  ok('a cached token minted a minute ago is reused without calling GitHub', r.stdout.trim() === 'ghs_CACHED' && records(curlLog).length === 0,
    `${r.stdout.trim()} calls=${records(curlLog).length} ${r.stderr.trim()}`);

  for (const [what, cache] of [
    ['a cached token minted over 5 minutes ago is not reused, though 55 minutes remain', { token: 'ghs_STALE', mintedAgo: 301, expiresIn: 3299 }],
    ['a one-line cache from an older copy (no mint time) is not trusted', { token: 'ghs_OLDFORMAT', oneLine: true, expiresIn: 3500 }],
    ['a cached token that is not an installation token is not served', { token: OWNER, mintedAgo: 10 }],
  ]) {
    fresh({ tokens: ['ghs_NEW'] });
    writeCache(cache);
    r = appToken();
    ok(what, r.stdout.trim() === 'ghs_NEW' && mints() === 1, `${r.stdout.trim()} mints=${mints()} ${r.stderr.trim()}`);
  }

  const first = fs.readFileSync(CACHE, 'utf8').split('\n')[0].split(' ');
  ok('after a mint the cache still starts "<expiry> <token>", the line older copies read',
    first.length === 2 && /^\d+$/.test(first[0]) && first[1] === 'ghs_NEW', first.join(' '));
  ok('the cache file is private (0600)', (fs.statSync(CACHE).mode & 0o777) === 0o600, (fs.statSync(CACHE).mode & 0o777).toString(8));

  // Two orgs: the cache is per org, and ORG picks the installation.
  fresh({ tokens: ['ghs_MARVINA'] });
  fs.writeFileSync(scenarioFile, JSON.stringify({
    [`GET ${API}/orgs/${ORG}/installation`]: { status: 200, body: { id: 42 } },
    [`GET ${API}/orgs/ThruuAi/installation`]: { status: 200, body: { id: 43 } },
    [`POST ${API}/app/installations/42/access_tokens`]: minted('ghs_MARVINA'),
    [`POST ${API}/app/installations/43/access_tokens`]: minted('ghs_THRUU'),
  }));
  writeCache({ token: 'ghs_MARVINA_CACHED', mintedAgo: 10 });
  r = run([path.join(IDENTITY, 'app-token.sh'), NAME], { MM_GH_ORG: 'ThruuAi' });
  ok('ORG=ThruuAi is not served the cached marvinamiranda token, and mints its own', r.stdout.trim() === 'ghs_THRUU' && mints() === 1, `${r.stdout.trim()} ${r.stderr.trim()}`);
  ok('the marvinamiranda cache is left untouched', readOr(CACHE).includes('ghs_MARVINA_CACHED'), readOr(CACHE));
  ok('the ThruuAi cache is its own file', readOr(`${CACHE}.thruuai`).includes('ghs_THRUU'), listOr(DIR).join(','));
  r = run([path.join(IDENTITY, 'app-token.sh'), NAME], { MM_GH_ORG: 'ThruuAi' });
  ok('a second ThruuAi call reuses its own cache', r.stdout.trim() === 'ghs_THRUU' && mints() === 1, r.stdout.trim());
  // Hard allowlist; an ambient ORG is ignored; nothing secret in argv; a bad value is never echoed.
  fs.writeFileSync(`${scenarioFile}.x`, '');
  const callsBefore = records(curlLog).length;
  const evil = 'Other-Org\nghs_SECRETVALUE';
  r = run([path.join(IDENTITY, 'app-token.sh'), NAME], { MM_GH_ORG: evil });
  ok('an org outside the allowlist is refused with no GitHub call', r.status !== 0 && r.stdout.trim() === '' && records(curlLog).length === callsBefore, r.stderr.trim());
  ok('a refused org is never echoed', !/Other-Org|SECRETVALUE/.test(r.stderr + r.stdout), r.stderr.trim());
  r = run([path.join(IDENTITY, 'app-token.sh'), NAME], { MM_GH_ORG: 'OtherInstalledOrg' });
  ok('an installed third org is refused too', r.status !== 0 && records(curlLog).length === callsBefore, r.stderr.trim());
  fs.rmSync(CACHE, { force: true });
  r = run([path.join(IDENTITY, 'app-token.sh'), NAME], { ORG: 'ThruuAi' });
  ok('an ambient ORG is ignored: marvinamiranda token', r.stdout.trim() === 'ghs_MARVINA', `${r.stdout.trim()} ${r.stderr.trim()}`);
  ok('no curl call carries a JWT or token in its argv',
    records(curlLog).every((c) => !c.argv.join(' ').includes('Bearer') && !/ghs_|eyJ/.test(c.argv.join(' '))) && records(curlLog).some((c) => c.auth.startsWith('Bearer ')),
    JSON.stringify(records(curlLog).map((c) => c.argv)));

  // First install (no bot-id file): the bot lookup keeps its token out of argv.
  fresh({ tokens: ['ghs_T1'] });
  agentEnv();
  const lookups = records(curlLog).filter((c) => /\/users\//.test(c.url));
  ok('the first-install bot lookup sends its token on stdin, not in argv',
    lookups.length === 1 && lookups[0].auth.startsWith('Bearer ghs_') && !lookups[0].argv.join(' ').includes('ghs_'), JSON.stringify(lookups));

  // Mutants of app-token.sh: each fix reverted must fail its check above.
  const mut = (name, edit, probe) => {
    const dir = fs.mkdtempSync(path.join(root, 'mut-'));
    const f = path.join(dir, 'app-token.sh');
    fs.writeFileSync(f, edit(fs.readFileSync(path.join(IDENTITY, 'app-token.sh'), 'utf8')), { mode: 0o755 });
    fresh({ tokens: ['ghs_T1'] });
    ok(`mutant (${name}) is caught`, probe(f), name);
  };
  const calls = () => records(curlLog);
  mut('allowlist removed', (t) => t.replace(/case "\$ORG" in\n[^]*?esac\n/, ''), (f) => {
    run([f, NAME], { MM_GH_ORG: 'OtherInstalledOrg' }); return calls().some((c) => /OtherInstalledOrg/.test(c.url)); });
  mut('ambient ORG honoured', (t) => t.replace('${MM_GH_ORG:-marvinamiranda}', '${ORG:-${MM_GH_ORG:-marvinamiranda}}'), (f) => {
    run([f, NAME], { ORG: 'ThruuAi' }); return calls().some((c) => /orgs\/ThruuAi/.test(c.url)); });
  mut('JWT back in argv', (t) => t.replace("printf 'header = \"Authorization: Bearer %s\"\\n' \"$jwt\" | curl -sS -K -", 'curl -sS -H "Authorization: Bearer $jwt"'), (f) => {
    run([f, NAME]); return calls().some((c) => c.argv.join(' ').includes('Bearer')); });
  mut('invalid org echoed', (t) => t.replace('organisation not allowed: only', 'organisation $ORG not allowed: only'), (f) => {
    const r = run([f, NAME], { MM_GH_ORG: 'LeakyOrg' }); return /LeakyOrg/.test(r.stderr); });

  for (const [what, broken] of [
    ['the installation is gone', { installation: { status: 404, body: { message: 'Not Found' } } }],
    ['GitHub mints an empty token', { tokens: [{ status: 201, body: { token: '', expires_at: iso(now() + 3600) } }] }],
  ]) {
    fresh(broken);
    r = appToken();
    ok(`app-token.sh prints nothing and fails when ${what}`, r.status !== 0 && r.stdout.trim() === '', `status ${r.status} stdout ${JSON.stringify(r.stdout)}`);
  }
})();

// ------------------------ create-app.py: the Checks App's key custody ----
// create-app.py runs under a Python harness that stands in for everything
// outside it: the browser (it fetches the local page and follows the callback),
// GitHub's manifest conversion (it answers with a fake PEM carrying a unique
// marker), and the fixed port (it binds an ephemeral one). The fake PEM
// reaches the harness on stdin, so it is never on disk; a stub `gh` first on
// PATH answers the preflight reads and records every call's argv, and only a
// hash of its stdin. Nothing here reaches the network.
//
// The proof that no key reached the disk is a grep of this suite's whole
// temporary tree, HOME and TMPDIR included, for the marker.
(function checksApp() {
  // create-app.py refuses to run unless its checkout is on
  // marvinamiranda/.github test (identity/provenance.sh), so it runs from a
  // throwaway checkout, and "GitHub" is a local bare repository reached
  // through a fake `git` (below), never through git configuration: the check
  // reads test with a clean configuration, so an insteadOf could not reach it,
  // and the cases below prove that one planted to redirect it is ignored.
  const cSrc = path.join(root, 'checks-src');
  const cCanon = path.join(root, 'checks-canon.git');
  const cIdentity = path.join(cSrc, 'governance', 'identity');
  fs.mkdirSync(cIdentity, { recursive: true });
  for (const f of fs.readdirSync(IDENTITY_SRC).filter((n) => n === 'create-app.py' || n === 'provenance.sh' || n.endsWith('.manifest.json'))) {
    fs.copyFileSync(path.join(IDENTITY_SRC, f), path.join(cIdentity, f));
  }
  git(root, 'init', '-q', cSrc);
  git(cSrc, 'add', '.');
  git(cSrc, 'commit', '-q', '-m', 'create-app');
  git(root, 'init', '-q', '--bare', cCanon);
  git(cCanon, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(cSrc, 'push', '-q', cCanon, 'HEAD:refs/heads/test');
  const CREATE_APP = path.join(cIdentity, 'create-app.py');
  const REPOS = ['prod-a', 'prod-b'];
  const ENV = 'governance-checks';
  const MARKER = `MM-CHECKS-FAKE-PEM-${crypto.randomBytes(12).toString('hex')}`;
  const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${MARKER}\n${crypto.randomBytes(48).toString('base64')}\n-----END RSA PRIVATE KEY-----\n`;
  const PEM_SHA = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const PEM_B64 = Buffer.from(PEM).toString('base64'); // how the Keychain holds it: one line
  const CLIENT_ID = 'Iv23.fakechecksclient';
  const cBin = path.join(root, 'checks-bin');
  const cHome = path.join(root, 'checks-home');
  const cTmp = path.join(root, 'checks-tmp');
  const cFixtures = path.join(root, 'checks-fixtures.json');
  const cGhLog = path.join(root, 'checks-gh.log');
  const cEvents = path.join(root, 'checks-events.log');
  const harness = path.join(root, 'checks-harness.py');
  const cSecState = path.join(root, 'checks-keychain.json');
  const cSecLog = path.join(root, 'checks-security.log');
  fs.mkdirSync(cBin, { recursive: true });

  // git: the real one, except that the canonical URL of marvinamiranda/.github
  // is served by FAKE_GITHUB (a local bare repository) after git's own URL
  // rewriting. It asks the real git what the URL becomes under the caller's
  // configuration and environment (\`ls-remote --get-url\`): if an insteadOf
  // rewrote it, the rewritten URL is used, exactly as git would; if not, it
  // stands for GitHub. So a configuration that redirects the canonical URL
  // behaves here as it would on the owner's machine.
  const REAL_GIT = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(cBin, 'fake-github'), cCanon); // where "GitHub" is: read by the fake git, whatever its environment
  fs.writeFileSync(path.join(cBin, 'git'), `#!/usr/bin/env bash
real=${JSON.stringify(REAL_GIT)}
canonical=${JSON.stringify(CANONICAL)}
pre=()
if [ "\${1-}" = -C ]; then pre=(-C "$2"); fi
hit=0
for a in "$@"; do if [ "$a" = "$canonical" ]; then hit=1; fi; done
# Stands in for a system gitconfig (Homebrew's /opt/homebrew/etc/gitconfig is
# writable by the owner's account): git reads it unless GIT_CONFIG_NOSYSTEM=1.
if [ -f ${JSON.stringify(path.join(cBin, 'system-gitconfig'))} ]; then export GIT_CONFIG_SYSTEM=${JSON.stringify(path.join(cBin, 'system-gitconfig'))}; fi
if [ $hit -eq 0 ]; then exec "$real" "$@"; fi
url="$("$real" \${pre[@]+"\${pre[@]}"} ls-remote --get-url "$canonical")"
if [ "$url" = "$canonical" ]; then url="$(cat ${JSON.stringify(path.join(cBin, 'fake-github'))})"; fi
{ env | sed 's/=.*//' | sort | tr '\\n' ' '; echo "GIT_TERMINAL_PROMPT_VALUE=\${GIT_TERMINAL_PROMPT-unset}"; } >> ${JSON.stringify(path.join(cBin, 'canonical-read-env.log'))}
args=()
for a in "$@"; do if [ "$a" = "$canonical" ]; then args+=("$url"); else args+=("$a"); fi; done
exec "$real" "\${args[@]}"
`, { mode: 0o755 });

  const hasPython = spawnSync('python3', ['-c', 'import sys; sys.exit(sys.version_info < (3, 8))']).status === 0;
  if (!hasPython) {
    ok('python3 3.8+ is available for the create-app.py cases', false, 'no python3');
    return;
  }

  // gh: `api <path>` answers from the fixtures (a 404 when absent); `secret
  // set` and `variable set` succeed unless FAKE_GH_FAIL names the repository.
  // It records argv and the SHA-256 of stdin, never stdin itself.
  fs.writeFileSync(path.join(cBin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const crypto = require('crypto');
const args = process.argv.slice(2);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch (e) { input = ''; }
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdinSha: input ? crypto.createHash('sha256').update(input).digest('hex') : null,
  stdinLength: input.length, token: process.env.GH_TOKEN === undefined ? null : process.env.GH_TOKEN }) + '\\n');
if (args[0] === 'api') {
  const fixtures = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, 'utf8'));
  const target = args.slice(1).filter((a) => !a.startsWith('-'))[0];
  if (!(target in fixtures)) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(fixtures[target]) + '\\n');
  process.exit(0);
}
if ((args[0] === 'secret' || args[0] === 'variable') && args[1] === 'set') {
  const repo = args[args.indexOf('--repo') + 1] || '';
  if (process.env.FAKE_GH_FAIL && repo.endsWith('/' + process.env.FAKE_GH_FAIL)) { process.stderr.write('HTTP 403: Resource not accessible\\n'); process.exit(1); }
  if (args[0] === 'variable' && process.env.FAKE_GH_FAIL_VARIABLE && repo.endsWith('/' + process.env.FAKE_GH_FAIL_VARIABLE)) { process.stderr.write('HTTP 403: variables\\n'); process.exit(1); }
  process.stdout.write('set\\n');
  process.exit(0);
}
process.stderr.write('stub gh: unexpected ' + args.join(' ') + '\\n');
process.exit(98);
`, { mode: 0o755 });

  // security: the macOS keychain CLI. Keeps its items in a JSON state file
  // holding each password's SHA-256 only, never the password. Commands come in
  // argv, or with -i one per line on stdin. It logs every call: argv as given
  // (so a secret put in argv shows up, on disk, and fails the marker search),
  // and stdin commands with the -w value replaced by its hash.
  fs.writeFileSync(path.join(cBin, 'security'), `#!/usr/bin/env node
const fs = require('fs');
const crypto = require('crypto');
const argv = process.argv.slice(2);
const stateFile = process.env.FAKE_SECURITY_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : [];
const log = (entry) => fs.appendFileSync(process.env.FAKE_SECURITY_LOG, JSON.stringify(entry) + '\\n');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
function tokens(line) {
  const out = []; let cur = null; let q = null;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur = cur || ''; continue; }
    if (/\\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur = (cur || '') + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}
function run(t) {
  const cmd = t[0]; const opt = {}; const flags = new Set(); const pos = [];
  for (let i = 1; i < t.length; i++) {
    if (['-a', '-s', '-w', '-l', '-j', '-T', '-p'].includes(t[i])) opt[t[i]] = t[++i];
    else if (t[i].startsWith('-')) flags.add(t[i]);
    else pos.push(t[i]);
  }
  const keychain = pos[0] || null;
  const match = (it) => it.service === opt['-s'] && (opt['-a'] === undefined || it.account === opt['-a']);
  if (cmd === 'find-generic-password') {
    if (flags.has('-w') || flags.has('-g')) { process.stderr.write('stub security: refusing to reveal a secret\\n'); return 97; }
    const it = state.find(match);
    if (!it) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); return 44; }
    process.stdout.write('keychain: "' + (it.keychain || '') + '"\\n    "acct"<blob>="' + it.account + '"\\n    "svce"<blob>="' + it.service + '"\\n');
    return 0;
  }
  if (cmd === 'add-generic-password') {
    if (process.env.FAKE_SECURITY_FAIL_ADD === '1') { process.stderr.write('security: SecKeychainItemCreateFromContent: failed\\n'); return 50; }
    if (process.env.FAKE_SECURITY_FAIL_ADD === 'silent') return 0; // reports success, stores nothing
    const at = state.findIndex((it) => it.service === opt['-s'] && it.account === opt['-a']);
    if (at >= 0 && !flags.has('-U')) { process.stderr.write('security: The specified item already exists in the keychain.\\n'); return 45; }
    const item = { service: opt['-s'], account: opt['-a'], keychain, passwordSha: sha(opt['-w'] || ''), trusted: opt['-T'] === undefined ? null : opt['-T'], anyApp: flags.has('-A') };
    if (at >= 0) state[at] = item; else state.push(item);
    return 0;
  }
  if (cmd === 'delete-generic-password') {
    const at = state.findIndex(match);
    if (at < 0) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); return 44; }
    state.splice(at, 1);
    return 0;
  }
  process.stderr.write('stub security: unexpected ' + t.join(' ') + '\\n');
  return 98;
}
let rc = 0;
if (argv.includes('-i')) {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch (e) { input = ''; }
  for (const line of input.split('\\n').filter((l) => l.trim())) {
    const t = tokens(line);
    const w = t.indexOf('-w');
    const shown = t.map((v, i) => (i === w + 1 && w >= 0 ? { passwordSha: sha(v), length: v.length } : v));
    log({ via: 'stdin', argv, command: shown });
    const code = run(t);
    if (code) rc = code;
  }
} else {
  log({ via: 'argv', argv });
  rc = run(argv);
}
fs.writeFileSync(stateFile, JSON.stringify(state));
process.exit(rc);
`, { mode: 0o755 });

  fs.writeFileSync(harness, `import html, http.client, http.server, json, os, re, runpy, sys, threading, urllib.request, webbrowser
pem = sys.stdin.read()
marker = os.environ['FAKE_MARKER']
def log(**kw):
    with open(os.environ['FAKE_EVENTS'], 'a') as f:
        f.write(json.dumps(kw) + '\\n')
class Resp:
    def __init__(self, body): self.body = body.encode()
    def read(self, *a): return self.body
    def __enter__(self): return self
    def __exit__(self, *a): return False
def fake_urlopen(req, *a, **k):
    url = getattr(req, 'full_url', req)
    method = req.get_method() if hasattr(req, 'get_method') else 'GET'
    m = re.fullmatch(r'https://api\\.github\\.com/app-manifests/([^/]+)/conversions', url)
    if m and method == 'POST':
        log(event='conversion', code=m.group(1))
        app = json.loads(os.environ['FAKE_APP'])
        if os.environ.get('FAKE_APP_AS_POSTED') == '1':  # as GitHub does: the App the page posted
            for key, field in (('name', 'name'), ('permissions', 'default_permissions'), ('events', 'default_events')):
                app[key] = posted_manifest[0][field]
        app['pem'] = pem
        return Resp(json.dumps(app))
    log(event='network', url=url)
    raise RuntimeError('no network in this test: ' + url)
urllib.request.urlopen = fake_urlopen
servers = []
Base = http.server.HTTPServer
class Ephemeral(Base):
    def __init__(self, addr, handler, *a, **k):
        log(event='bind', port=addr[1])
        super().__init__((addr[0], 0), handler, *a, **k)
        servers.append(self)
http.server.HTTPServer = Ephemeral
def browser(url, *a, **k):
    log(event='page', url=url)
    def walk():
        port = servers[0].server_address[1]
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
        c.request('GET', '/')
        page = c.getresponse().read().decode()
        state = re.search(r'[?&]state=([^&\\'"]+)', page).group(1)
        value = re.search(r"name='manifest' value=\\"([^\\"]*)\\"", page).group(1)
        posted_manifest.append(json.loads(html.unescape(value)))
        log(event='form', manifest=posted_manifest[0])
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=60)
        c.request('GET', '/callback?state=' + state + '&code=fakecode')
        r = c.getresponse()
        body = r.read().decode()
        log(event='callback', status=r.status, marker=marker in body)
    t = threading.Thread(target=walk, daemon=True)
    walkers.append(t)
    t.start()
    return True
walkers = []
posted_manifest = []
webbrowser.open = browser
import subprocess
_run = subprocess.run
def run_then_touch(cmd, *a, **k):
    if any(str(c).endswith('provenance.sh') for c in cmd):
        given = k.get('env')
        log(event='provenance-env', keys=sorted((os.environ if given is None else given).keys()))
    result = _run(cmd, *a, **k)
    after = os.environ.get('FAKE_AFTER_PROVENANCE')
    if after and any(str(c).endswith('provenance.sh') for c in cmd):
        target, text = json.loads(after)
        with open(target, 'w') as f:
            f.write(text)
    return result
subprocess.run = run_then_touch
sys.argv = [sys.argv[1]] + sys.argv[2:]
try:
    runpy.run_path(sys.argv[0], run_name='__main__')
finally:
    for t in walkers:
        t.join(30)
`);

  // A healthy target: default branch test, the environment with a custom
  // policy whose one rule is test, and a public key the credential can read.
  function repoFixtures(r, { env = 'ok', rules = [{ id: 1, name: 'test', type: 'branch' }], secret = false } = {}) {
    const base = `repos/${ORG}/${r}`;
    const e = `${base}/environments/${ENV}`;
    const fx = { [base]: { name: r, full_name: `${ORG}/${r}`, default_branch: 'test' } };
    if (env === 'missing') return fx;
    fx[e] = { name: ENV, deployment_branch_policy: env === 'protected' ? { protected_branches: true, custom_branch_policies: false }
      : env === 'open' ? null : { protected_branches: false, custom_branch_policies: true } };
    fx[`${e}/deployment-branch-policies?per_page=100`] = { total_count: rules.length, branch_policies: rules };
    fx[`${e}/secrets/public-key`] = { key_id: 'k1', key: 'AAAA' };
    if (secret) fx[`${e}/secrets/CHECKS_APP_PRIVATE_KEY`] = { name: 'CHECKS_APP_PRIVATE_KEY', updated_at: '2026-09-27T00:00:00Z' };
    return fx;
  }
  const allRepos = (opts = {}) => Object.assign({}, ...REPOS.map((r) => repoFixtures(r, opts[r] || {})));

  // What the manifest conversion returns: by default the App the manifest in
  // the checkout describes, owned by the organisation. \`app\` changes it.
  function convertedApp(name, change = (a) => a) {
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(cIdentity, `${name}.manifest.json`), 'utf8')); } catch (e) { m = {}; }
    return change({ id: 4242, slug: 'fake-checks', client_id: CLIENT_ID, html_url: 'https://github.com/apps/fake-checks',
      name: m.name, owner: { login: ORG, type: 'Organization' }, permissions: m.default_permissions, events: m.default_events,
      client_secret: 'fake-client-secret', webhook_secret: null });
  }
  function createApp(args, { fx = allRepos(), extraEnv = {}, fail = '', failVariable = '', pyFlags = ['-I', '-S'], app = (a) => a, homeGitconfig = '', keychain = [], failKeychainAdd = false, pem = PEM, cwd = undefined } = {}) { // failKeychainAdd: false | true | 'silent'
    fs.rmSync(cHome, { recursive: true, force: true });
    fs.rmSync(cTmp, { recursive: true, force: true });
    fs.mkdirSync(cHome, { recursive: true });
    fs.mkdirSync(cTmp, { recursive: true });
    if (homeGitconfig) fs.writeFileSync(path.join(cHome, '.gitconfig'), homeGitconfig);
    fs.writeFileSync(cSecState, JSON.stringify(keychain));
    fs.writeFileSync(cSecLog, '');
    fs.writeFileSync(cFixtures, JSON.stringify(fx));
    for (const f of [cGhLog, cEvents]) fs.writeFileSync(f, '');
    const r = spawnSync('python3', [...pyFlags, harness, CREATE_APP, ...args], {
      cwd,
      input: pem,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        PATH: [cBin, SYS_PATH].join(':'),
        HOME: cHome,
        TMPDIR: cTmp,
        LANG: 'C',
        GH_TOKEN: 'github_pat_FAKEOWNERTOKEN',
        FAKE_GH_LOG: cGhLog,
        FAKE_GH_FIXTURES: cFixtures,
        FAKE_GH_FAIL: fail,
        FAKE_GH_FAIL_VARIABLE: failVariable,
        FAKE_SECURITY_STATE: cSecState,
        FAKE_SECURITY_LOG: cSecLog,
        FAKE_SECURITY_FAIL_ADD: failKeychainAdd === 'silent' ? 'silent' : failKeychainAdd ? '1' : '0',
        FAKE_EVENTS: cEvents,
        FAKE_MARKER: MARKER,
        FAKE_APP: JSON.stringify(convertedApp(args[0], app)),
        GIT_CONFIG_NOSYSTEM: '1',
        ...extraEnv,
      },
    });
    const gh = records(cGhLog);
    const events = records(cEvents);
    return {
      ...r,
      gh,
      events,
      sets: gh.filter((c) => (c.args[0] === 'secret' || c.args[0] === 'variable') && c.args[1] === 'set'),
      opened: events.some((e) => e.event === 'page' || e.event === 'bind'),
      converted: events.filter((e) => e.event === 'conversion').length,
      sec: records(cSecLog),
      kc: JSON.parse(readOr(cSecState, '[]')),
    };
  }
  const cTail = (r) => `exit ${r.status}; ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`;

  // Every file under the suite's temporary tree (HOME and TMPDIR are inside
  // it) that holds the marker.
  function filesWithMarker(dir = root) {
    const hits = [];
    const walk = (d) => {
      for (const ent of listOr(d).map((n) => path.join(d, n))) {
        let st;
        try { st = fs.lstatSync(ent); } catch (e) { continue; }
        if (st.isDirectory()) walk(ent);
        else if (st.isFile() && (fs.readFileSync(ent).includes(MARKER) || fs.readFileSync(ent).includes(PEM_B64))) hits.push(ent);
      }
    };
    walk(dir);
    return hits;
  }
  const keyFile = () => path.join(cHome, '.config', 'mm-agent', 'mm-checks', 'private-key.pem');
  const checksDir = () => path.join(cHome, '.config', 'mm-agent', 'mm-checks');
  const argvHasKey = (r) => r.gh.some((c) => c.args.some((a) => a.includes(MARKER) || a.includes('PRIVATE KEY')));

  // ---- the manifest ----
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(IDENTITY_SRC, 'mm-checks.manifest.json'), 'utf8')); } catch (e) { manifest = { default_permissions: {} }; }
  ok('mm-checks.manifest.json: default_permissions is exactly checks write, statuses write, metadata read',
    JSON.stringify(Object.entries(manifest.default_permissions).sort()) === JSON.stringify([['checks', 'write'], ['metadata', 'read'], ['statuses', 'write']]),
    JSON.stringify(manifest.default_permissions));
  ok('mm-checks.manifest.json: no webhook, no events, private, named "MarvinaMiranda Checks"',
    manifest.hook_attributes && manifest.hook_attributes.active === false && Array.isArray(manifest.default_events)
      && manifest.default_events.length === 0 && manifest.public === false && manifest.name === 'MarvinaMiranda Checks',
    JSON.stringify({ hook: manifest.hook_attributes, events: manifest.default_events, public: manifest.public, name: manifest.name }));

  // ---- the flow ----
  const args = ['mm-checks', '--to-environment', ...REPOS.flatMap((r) => ['--repo', r])];
  let r = createApp(args);
  ok('create-app.py mm-checks --to-environment completes against a stubbed GitHub',
    r.status === 0 && r.converted === 1 && r.events.some((e) => e.event === 'callback' && e.status === 200), cTail(r));
  const form = r.events.find((e) => e.event === 'form');
  ok('the page posts mm-checks.manifest.json, with the local callback as its redirect',
    form && JSON.stringify(form.manifest.default_permissions) === JSON.stringify(manifest.default_permissions)
      && form.manifest.hook_attributes.active === false && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(form.manifest.redirect_url),
    form && JSON.stringify(form.manifest));
  for (const repo of REPOS) {
    const secrets = r.sets.filter((c) => c.args[0] === 'secret' && c.args.includes(`${ORG}/${repo}`));
    const vars = r.sets.filter((c) => c.args[0] === 'variable' && c.args.includes(`${ORG}/${repo}`));
    ok(`${repo}: exactly one CHECKS_APP_PRIVATE_KEY secret in environment governance-checks, the PEM arriving on stdin`,
      secrets.length === 1 && secrets[0].args[2] === 'CHECKS_APP_PRIVATE_KEY'
        && secrets[0].args.join(' ').includes(`--env ${ENV}`) && secrets[0].stdinSha === PEM_SHA(PEM),
      JSON.stringify(secrets.map((c) => ({ args: c.args, sha: c.stdinSha }))));
    ok(`${repo}: exactly one CHECKS_APP_CLIENT_ID variable in environment governance-checks, holding the client id`,
      vars.length === 1 && vars[0].args[2] === 'CHECKS_APP_CLIENT_ID' && vars[0].args.join(' ').includes(`--env ${ENV}`)
        && vars[0].args[vars[0].args.indexOf('--body') + 1] === CLIENT_ID && vars[0].stdinSha === null,
      JSON.stringify(vars.map((c) => c.args)));
  }
  ok('no set call went to any other repository or environment',
    r.sets.length === 2 * REPOS.length && r.sets.every((c) => c.args.join(' ').includes(`--env ${ENV}`)), JSON.stringify(r.sets.map((c) => c.args)));
  ok('the PEM is in no gh call\'s argv', !argvHasKey(r), '');
  ok('the PEM reached gh on stdin exactly once per repository, and on no other call',
    r.gh.filter((c) => c.stdinSha === PEM_SHA(PEM)).length === REPOS.length
      && r.gh.every((c) => c.stdinSha === null || c.stdinSha === PEM_SHA(PEM)), JSON.stringify(r.gh.map((c) => c.stdinSha)));
  ok('no file under the temporary tree (HOME and TMPDIR included) holds the PEM\'s marker', filesWithMarker().length === 0, filesWithMarker().join(', '));
  ok('no private-key.pem for mm-checks', !fs.existsSync(keyFile()), keyFile());
  ok('no temporary file is left behind in TMPDIR', listOr(cTmp).length === 0, listOr(cTmp).join(', '));
  ok('the PEM is never printed, nor shown on the callback page',
    !`${r.stdout}${r.stderr}`.includes(MARKER) && !/PRIVATE KEY/.test(`${r.stdout}${r.stderr}`)
      && r.events.some((e) => e.event === 'callback' && e.marker === false), '');
  const meta = readOr(path.join(checksDir(), 'app.json'));
  ok('app.json records the App\'s id and client id and holds no secret',
    meta !== '' && JSON.parse(meta).id === 4242 && JSON.parse(meta).client_id === CLIENT_ID
      && !/PRIVATE KEY|pem|client_secret|fake-client-secret/.test(meta), meta);
  ok('it tells the owner to install the App on the selected repositories only',
    /apps\/fake-checks\/installations\/new/.test(r.stdout) && /prod-a/.test(r.stdout) && /prod-b/.test(r.stdout) && !/All repositories/.test(r.stdout), r.stdout);

  // ---- provenance: only from a commit on marvinamiranda/.github test ----
  const provEnv = r.events.find((e) => e.event === 'provenance-env');
  ok('provenance.sh is run with PATH and TMPDIR only: never the owner\'s GH_TOKEN, nor anything else of the environment',
    provEnv && provEnv.keys.every((k) => k === 'PATH' || k === 'TMPDIR') && provEnv.keys.includes('PATH'), JSON.stringify(provEnv && provEnv.keys));
  ok('it runs from a commit on test, and says which', /Running from marvinamiranda\/\.github commit [0-9a-f]{40}, which is on test/.test(r.stdout), r.stdout.split('\n')[0]);
  const provenanceRefused = (x) => x.status !== 0 && !x.opened && x.converted === 0 && x.gh.length === 0 && !fs.existsSync(checksDir());
  const merged = git(cSrc, 'rev-parse', 'HEAD');
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'local, not on test');
  let p = createApp(args);
  git(cSrc, 'reset', '-q', '--hard', merged);
  ok('refuses to run from a commit that is not on test: before any gh call or page, nothing created',
    provenanceRefused(p) && /not on marvinamiranda\/\.github test/.test(p.stderr), `${cTail(p)} gh=${p.gh.length} opened=${p.opened}`);
  fs.writeFileSync(path.join(cIdentity, 'planted.txt'), 'untracked\n');
  p = createApp(args);
  fs.rmSync(path.join(cIdentity, 'planted.txt'));
  ok('refuses to run with an untracked file under governance/: before any gh call or page, nothing created',
    provenanceRefused(p) && /uncommitted changes/.test(p.stderr), `${cTail(p)} gh=${p.gh.length} opened=${p.opened}`);
  fs.appendFileSync(CREATE_APP, '# a local edit\n');
  p = createApp(args);
  git(cSrc, 'checkout', '-q', '--', '.');
  ok('refuses to run from a checkout with uncommitted changes: before any gh call or page, nothing created',
    provenanceRefused(p) && /uncommitted changes/.test(p.stderr), `${cTail(p)} gh=${p.gh.length} opened=${p.opened}`);
  p = createApp(['mm-agent']);
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'local, not on test');
  const pAgent = createApp(['mm-agent']);
  git(cSrc, 'reset', '-q', '--hard', merged);
  ok('the rule holds for every identity: mm-agent runs at a merged commit and is refused from an unmerged one',
    p.status === 0 && pAgent.status !== 0 && !pAgent.opened && /not on marvinamiranda\/\.github test/.test(pAgent.stderr), `${cTail(p)} / ${cTail(pAgent)}`);
  fs.rmSync(cHome, { recursive: true, force: true }); // mm-agent's key holds the marker by design

  // ---- isolation: python3 -I, before anything else runs ----
  const planted = path.join(root, 'checks-planted');
  const plantedMarker = path.join(root, 'checks-planted-ran');
  const plant = (file, where) => fs.writeFileSync(path.join(where, file),
    `open(${JSON.stringify(plantedMarker)}, 'a').write(${JSON.stringify(file)} + '\\n')\nimport sys\nsys.exit(3)\n`);
  function direct(pyFlags, extraEnv = {}, python = 'python3') {
    fs.rmSync(plantedMarker, { force: true });
    fs.writeFileSync(cGhLog, '');
    // A target no fixture knows: should a mutant get past every earlier check,
    // the preflight refuses before the real browser or port 8765 is touched.
    return spawnSync(python, [...pyFlags, CREATE_APP, 'mm-checks', '--to-environment', '--repo', 'no-such-repo'], { encoding: 'utf8', timeout: 30000, input: '',
      env: { PATH: [cBin, SYS_PATH].join(':'), HOME: cHome, TMPDIR: cTmp, LANG: 'C', GH_TOKEN: 'github_pat_FAKEOWNERTOKEN',
        FAKE_GH_LOG: cGhLog, FAKE_GH_FIXTURES: cFixtures, GIT_CONFIG_NOSYSTEM: '1', ...extraEnv } });
  }
  let iso = createApp(args, { pyFlags: [] });
  ok('refuses to run without python3 -I, before any gh call or page, nothing created',
    iso.status !== 0 && /python3 -I/.test(iso.stderr) && !iso.opened && iso.gh.length === 0 && !fs.existsSync(checksDir()), `${cTail(iso)} gh=${iso.gh.length}`);
  plant('secrets.py', cIdentity);
  let d = direct(['-B']); // -B: no __pycache__ left in the checkout if a mutant imports the plant
  ok('without -I, a secrets.py planted beside the script never runs: the refusal comes first',
    d.status !== 0 && d.status !== 3 && /python3 -I/.test(d.stderr) && !fs.existsSync(plantedMarker), `exit ${d.status} ran=${readOr(plantedMarker).trim()} ${d.stderr.trim()}`);
  fs.mkdirSync(planted, { recursive: true });
  plant('sitecustomize.py', planted);
  plant('usercustomize.py', planted);
  d = direct(['-I', '-S', '-B'], { PYTHONPATH: planted, PYTHONUSERBASE: planted });
  ok('with -I, neither the planted secrets.py nor a sitecustomize on PYTHONPATH runs, and the untracked file is refused',
    d.status !== 0 && d.status !== 3 && !fs.existsSync(plantedMarker) && /uncommitted changes/.test(d.stderr), `exit ${d.status} ran=${readOr(plantedMarker).trim()} ${d.stderr.trim()}`);
  fs.rmSync(path.join(cIdentity, 'secrets.py'), { force: true });
  fs.rmSync(path.join(cIdentity, '__pycache__'), { recursive: true, force: true });

  // ---- provenance reads test with a clean git configuration ----
  const cEvil = path.join(root, 'checks-evil.git');
  git(root, 'init', '-q', '--bare', cEvil);
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'local, not on test');
  git(cSrc, 'push', '-q', '-f', cEvil, 'HEAD:refs/heads/test');
  const control = spawnSync('git', ['ls-remote', CANONICAL, 'refs/heads/test'], { encoding: 'utf8',
    env: { PATH: [cBin, SYS_PATH].join(':'), HOME: cHome, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${cEvil}.insteadOf`, GIT_CONFIG_VALUE_0: CANONICAL } });
  ok('control: a planted insteadOf does redirect the canonical URL for an ordinary git call (so the cases below can fail)',
    control.stdout.startsWith(git(cSrc, 'rev-parse', 'HEAD')), control.stdout + control.stderr);
  for (const [what, opts, local] of [
    ['GIT_CONFIG_COUNT in the environment', { extraEnv: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${cEvil}.insteadOf`, GIT_CONFIG_VALUE_0: CANONICAL } }],
    ['GIT_CONFIG_PARAMETERS in the environment', { extraEnv: { GIT_CONFIG_PARAMETERS: `'url.${cEvil}.insteadof'='${CANONICAL}'` } }],
    ['the global ~/.gitconfig', { homeGitconfig: `[url "${cEvil}"]\n\tinsteadOf = ${CANONICAL}\n` }],
    ['the checkout\'s own .git/config', {}, true],
  ]) {
    if (local) git(cSrc, 'config', `url.${cEvil}.insteadOf`, CANONICAL);
    const x = createApp(args, opts);
    if (local) git(cSrc, 'config', '--unset', `url.${cEvil}.insteadOf`);
    ok(`an insteadOf in ${what} pointing test at an unmerged commit is ignored: refused`,
      x.status !== 0 && /not on marvinamiranda\/\.github test/.test(x.stderr) && !x.opened && x.gh.length === 0, `${cTail(x)} opened=${x.opened}`);
  }
  git(cSrc, 'reset', '-q', '--hard', merged);

  // ---- an older merged commit runs, with a warning ----
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'merged later');
  git(cSrc, 'push', '-q', cCanon, 'HEAD:refs/heads/test');
  git(cSrc, 'reset', '-q', '--hard', merged);
  let older = createApp(args);
  git(cSrc, 'push', '-q', '-f', cCanon, 'HEAD:refs/heads/test');
  ok('from a merged commit that is not test\'s tip it runs, and warns', older.status === 0 && /WARNING: .*not test's tip/.test(older.stdout), `${cTail(older)} ${older.stdout.split('\n').slice(0, 2).join(' | ')}`);
  ok('from test\'s tip it does not warn', !/not test's tip/.test(r.stdout), r.stdout.split('\n').slice(0, 2).join(' | '));

  // ---- a hidden edit under governance/ is still an edit ----
  const manifestFile = path.join(cIdentity, 'mm-checks.manifest.json');
  const headManifest = fs.readFileSync(manifestFile, 'utf8');
  const widened = JSON.stringify({ ...manifest, default_permissions: { ...manifest.default_permissions, administration: 'write' } }, null, 2);
  git(cSrc, 'update-index', '--skip-worktree', 'governance/identity/mm-checks.manifest.json');
  fs.writeFileSync(manifestFile, widened);
  let hidden = createApp(args);
  fs.writeFileSync(manifestFile, headManifest);
  git(cSrc, 'update-index', '--no-skip-worktree', 'governance/identity/mm-checks.manifest.json');
  ok('an edit hidden from git status (skip-worktree) is refused as uncommitted', hidden.status !== 0 && /differs from|uncommitted/.test(hidden.stderr)
    && !hidden.opened && hidden.gh.length === 0, `${cTail(hidden)} opened=${hidden.opened}`);

  // ---- the manifest is the committed one, even if the file changes after the check ----
  let toctou = createApp(args, { extraEnv: { FAKE_AFTER_PROVENANCE: JSON.stringify([manifestFile, widened]) } });
  fs.writeFileSync(manifestFile, headManifest);
  const posted = toctou.events.find((e) => e.event === 'form');
  ok('a manifest changed on disk after the provenance check is not what the page posts: the committed one is',
    toctou.status === 0 && posted && JSON.stringify(posted.manifest.default_permissions) === JSON.stringify(manifest.default_permissions), `${cTail(toctou)} ${posted && JSON.stringify(posted.manifest.default_permissions)}`);

  // ---- the App GitHub created must be the one the manifest describes ----
  for (const [what, change] of [
    ['owned by another account', (a) => ({ ...a, owner: { login: 'someone-else', type: 'User' } })],
    ['with another name', (a) => ({ ...a, name: 'Something Else' })],
    ['with a permission the manifest does not ask for', (a) => ({ ...a, permissions: { ...a.permissions, administration: 'write' } })],
    ['missing a permission the manifest asks for', (a) => ({ ...a, permissions: { checks: 'write', metadata: 'read' } })],
  ]) {
    const x = createApp(args, { app: change });
    ok(`an App ${what} is refused: its key discarded, nothing loaded or written, and the App named for deletion`,
      x.status !== 0 && x.converted === 1 && x.sets.length === 0 && !fs.existsSync(checksDir()) && /not the one the manifest describes/.test(x.stderr)
        && /[Dd]elete/.test(x.stderr) && filesWithMarker().length === 0 && !`${x.stdout}${x.stderr}`.includes(MARKER), `${cTail(x)} sets=${x.sets.length}`);
  }
  const foreignAgent = createApp(['mm-agent'], { app: (a) => ({ ...a, owner: { login: 'someone-else', type: 'User' } }) });
  ok('...and for mm-agent too: no key file is written for an App that is not the manifest\'s',
    foreignAgent.status !== 0 && !fs.existsSync(path.join(cHome, '.config', 'mm-agent', 'mm-agent', 'private-key.pem')), cTail(foreignAgent));

  // ---- the recovery message whatever fails ----
  let rec = createApp(args, { failVariable: 'prod-a' });
  ok('when the variable fails after the secret loaded, the recovery names that repository as holding the key',
    rec.status !== 0 && /hold the key: [^\n]*marvinamiranda\/prod-a/.test(rec.stderr) && /[Dd]elete/.test(rec.stderr), cTail(rec));
  rec = createApp(args, { app: (a) => { const b = { ...a }; delete b.client_id; return b; } });
  ok('when loading raises, the recovery still prints, naming the repository that holds the key, and it exits',
    rec.status !== null && rec.status !== 0 && /hold the key: [^\n]*marvinamiranda\/prod-a/.test(rec.stderr) && !`${rec.stdout}${rec.stderr}`.includes(MARKER), cTail(rec));

  // ---- -S: no site-packages, so no .pth file runs ----
  iso = createApp(args, { pyFlags: ['-I'] });
  ok('refuses to run with -I but without -S, before any gh call or page, nothing created',
    iso.status !== 0 && /python3 -I -S/.test(iso.stderr) && !iso.opened && iso.gh.length === 0 && !fs.existsSync(checksDir()), `${cTail(iso)} gh=${iso.gh.length}`);
  // A .pth in site-packages runs at start-up even under -I (Homebrew's is
  // user-writable). A throwaway venv gives a site-packages this suite owns.
  const venv = path.join(root, 'checks-venv');
  const made = spawnSync('python3', ['-m', 'venv', '--without-pip', venv], { encoding: 'utf8' });
  const vpy = path.join(venv, 'bin', 'python3');
  const site = made.status === 0 ? spawnSync(vpy, ['-c', 'import site; print(site.getsitepackages()[0])'], { encoding: 'utf8' }).stdout.trim() : '';
  if (!site) {
    ok('a throwaway venv for the .pth drill', false, made.stderr);
  } else {
    fs.writeFileSync(path.join(site, 'planted.pth'), `import os; open(${JSON.stringify(plantedMarker)}, 'a').write('pth\\n')\n`);
    d = direct(['-I', '-B'], {}, vpy);
    ok('control: under -I alone a planted .pth runs before the script, which then refuses for want of -S',
      fs.existsSync(plantedMarker) && d.status !== 0 && /python3 -I -S/.test(d.stderr) && readOr(cGhLog) === '', `ran=${fs.existsSync(plantedMarker)} ${d.stderr.trim()}`);
    d = direct(['-I', '-S', '-B'], {}, vpy);
    ok('with -I -S the planted .pth never runs', !fs.existsSync(plantedMarker), `exit ${d.status} ran=${readOr(plantedMarker).trim()} ${d.stderr.trim()}`);
  }

  // ---- replace refs and grafts cannot make an unmerged commit look merged ----
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'local, not on test');
  const unmerged = git(cSrc, 'rev-parse', 'HEAD');
  git(cSrc, 'replace', '--graft', merged, unmerged); // test's commit now "descends" from the unmerged one
  let drill = createApp(args);
  git(cSrc, 'replace', '-d', merged);
  ok('a replace ref grafting test onto an unmerged commit is ignored: refused', drill.status !== 0 && /not on marvinamiranda\/\.github test/.test(drill.stderr)
    && !drill.opened && drill.gh.length === 0, `${cTail(drill)} opened=${drill.opened}`);
  const graftFile = path.join(cSrc, '.git', 'info', 'grafts');
  fs.mkdirSync(path.dirname(graftFile), { recursive: true });
  fs.writeFileSync(graftFile, `${merged} ${unmerged}\n`);
  drill = createApp(args);
  fs.rmSync(graftFile, { force: true });
  ok('a .git/info/grafts entry grafting test onto an unmerged commit is ignored: refused', drill.status !== 0 && /not on marvinamiranda\/\.github test/.test(drill.stderr)
    && !drill.opened && drill.gh.length === 0, `${cTail(drill)} opened=${drill.opened}`);
  // A forged commit-graph (under .git, outside the content check): the parent
  // of test's tip made to list the unmerged commit as its only parent. Not the
  // tip itself: merge-base parses the two commits it is given from their
  // objects, and every commit it walks to from the graph.
  git(cSrc, 'reset', '-q', '--hard', merged);
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'merged');
  git(cSrc, 'push', '-q', '-f', cCanon, 'HEAD:refs/heads/test');
  const tip = git(cSrc, 'rev-parse', 'HEAD');
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'local, not on test');
  const graphUnmerged = git(cSrc, 'rev-parse', 'HEAD');
  let graph = forgeCommitGraph(cSrc, merged, { parent: graphUnmerged });
  const graphFooled = spawnSync(REAL_GIT, ['-C', cSrc, 'merge-base', '--is-ancestor', graphUnmerged, tip], { env: gitEnv }).status === 0;
  drill = createApp(args);
  fs.rmSync(graph, { force: true });
  git(cSrc, 'push', '-q', '-f', cCanon, `${merged}:refs/heads/test`);
  ok('control: the forged commit-graph makes plain git believe the unmerged commit is on test', graphFooled, '');
  ok('a forged commit-graph making test descend from an unmerged commit is ignored: refused', drill.status !== 0 && /not on marvinamiranda\/\.github test/.test(drill.stderr)
    && !drill.opened && drill.gh.length === 0, `${cTail(drill)} opened=${drill.opened}`);
  git(cSrc, 'reset', '-q', '--hard', merged);
  // The reviewer's drill: at a merged commit, a replace ref swaps the manifest's
  // blob for one asking administration: write. The committed bytes are what count.
  const blob = git(cSrc, 'rev-parse', `${merged}:governance/identity/mm-checks.manifest.json`);
  const evilBlob = execFileSync('git', ['-C', cSrc, 'hash-object', '-w', '--stdin'], { input: widened, env: gitEnv }).toString().trim();
  git(cSrc, 'replace', blob, evilBlob);
  drill = createApp(args, { extraEnv: { FAKE_APP_AS_POSTED: '1' } });
  git(cSrc, 'replace', '-d', blob);
  const drillPosted = drill.events.find((e) => e.event === 'form');
  ok('a replace ref swapping the manifest\'s blob is ignored: the page posts the committed manifest',
    drillPosted && JSON.stringify(drillPosted.manifest.default_permissions) === JSON.stringify(manifest.default_permissions),
    `${cTail(drill)} posted=${drillPosted && JSON.stringify(drillPosted.manifest.default_permissions)}`);
  // The same through a forged commit-graph: the checked commit's root tree
  // swapped for one holding the widened manifest.
  const evilIndex = path.join(root, 'checks-evil-index');
  const idx = { ...gitEnv, GIT_INDEX_FILE: evilIndex };
  execFileSync('git', ['-C', cSrc, 'read-tree', merged], { env: idx });
  execFileSync('git', ['-C', cSrc, 'update-index', '--cacheinfo', `100644,${evilBlob},governance/identity/mm-checks.manifest.json`], { env: idx });
  const evilTree = execFileSync('git', ['-C', cSrc, 'write-tree'], { env: idx }).toString().trim();
  fs.rmSync(evilIndex, { force: true });
  graph = forgeCommitGraph(cSrc, merged, { tree: evilTree });
  const treeFooled = git(cSrc, 'log', '-1', '--format=%T', merged) === evilTree;
  drill = createApp(args, { extraEnv: { FAKE_APP_AS_POSTED: '1' } });
  fs.rmSync(graph, { force: true });
  const graphPosted = drill.events.find((e) => e.event === 'form');
  ok('control: the forged commit-graph gives the checked commit another tree for plain git', treeFooled, '');
  ok('a forged commit-graph swapping the checked commit\'s tree is ignored: the page posts the committed manifest',
    graphPosted && JSON.stringify(graphPosted.manifest.default_permissions) === JSON.stringify(manifest.default_permissions),
    `${cTail(drill)} posted=${graphPosted && JSON.stringify(graphPosted.manifest.default_permissions)}`);

  // ---- marvinamiranda/.github#26: nothing under the checkout's .git runs or decides ----
  // Config there must never execute (create-app.py holds the owner's token in
  // its environment), and none of its objects may answer for test or for the
  // manifest: a forged object is filed under a real id, and git trusts the id.
  for (const [what, plantIt, unplant, control] of [
    ['a core.fsmonitor hook', (hook) => git(cSrc, 'config', 'core.fsmonitor', hook), () => git(cSrc, 'config', '--unset', 'core.fsmonitor'),
      () => spawnSync(REAL_GIT, ['-C', cSrc, 'status', '--porcelain'], { env: { ...gitEnv, GH_TOKEN: 'github_pat_FAKEOWNERTOKEN' } })],
    ['a clean filter on every path', (hook) => {
      git(cSrc, 'config', 'filter.mm.clean', `${hook}; cat`);
      fs.writeFileSync(path.join(cSrc, '.git', 'info', 'attributes'), '* filter=mm\n');
    }, () => {
      git(cSrc, 'config', '--remove-section', 'filter.mm');
      fs.rmSync(path.join(cSrc, '.git', 'info', 'attributes'), { force: true });
    }, () => spawnSync(REAL_GIT, ['-C', cSrc, 'hash-object', '--', 'governance/identity/create-app.py'], { env: { ...gitEnv, GH_TOKEN: 'github_pat_FAKEOWNERTOKEN' } })],
  ]) {
    const ran = path.join(root, 'checks-hook-ran.log');
    const hook = path.join(root, 'checks-hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\necho "token=\${GH_TOKEN-unset}" >> ${JSON.stringify(ran)}\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(cSrc, '.git', 'info'), { recursive: true });
    plantIt(hook);
    control();
    const fired = readOr(ran).includes('token=github_pat_FAKEOWNERTOKEN');
    fs.rmSync(ran, { force: true });
    drill = createApp(args);
    const after = readOr(ran);
    unplant();
    fs.rmSync(ran, { force: true });
    ok(`control: ${what} in the checkout's own config runs for plain git, with the caller's token`, fired, '');
    ok(`${what} in the checkout's own config never runs: create-app.py completes, and the hook never ran`,
      drill.status === 0 && drill.converted === 1 && after === '', `${cTail(drill)} ran=${after.trim().split('\n').join(',')}`);
  }
  // A replaced pack: the parent of test's tip filed as a forged commit whose
  // parent is the unmerged HEAD.
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'merged');
  git(cSrc, 'push', '-q', '-f', cCanon, 'HEAD:refs/heads/test');
  const packTip = git(cSrc, 'rev-parse', 'HEAD');
  execFileSync('git', ['-C', cSrc, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'local, not on test'],
    { env: { ...gitEnv, ...BACKDATED } }); // older than test's tip (object-forge.js)
  const packUnmerged = git(cSrc, 'rev-parse', 'HEAD');
  let restoreObjects = forgePackParent(cSrc, merged, packUnmerged);
  const packFooled = spawnSync(REAL_GIT, ['-C', cSrc, '-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', packUnmerged, packTip],
    { env: { ...gitEnv, GIT_NO_REPLACE_OBJECTS: '1' } }).status === 0;
  drill = createApp(args);
  restoreObjects();
  git(cSrc, 'reset', '-q', '--hard', merged);
  git(cSrc, 'push', '-q', '-f', cCanon, `${merged}:refs/heads/test`);
  ok('control: the replaced pack makes plain git believe the unmerged commit is on test', packFooled, '');
  ok('a replaced pack making test descend from an unmerged commit is ignored: refused', drill.status !== 0 && /not on marvinamiranda\/\.github test/.test(drill.stderr)
    && !drill.opened && drill.gh.length === 0, `${cTail(drill)} opened=${drill.opened}`);
  // A forged loose object filed under the manifest's blob id: the working file
  // still hashes to the real id, so only the bytes read back differ.
  restoreObjects = forgeLooseObject(cSrc, blob, 'blob', widened);
  const blobFooled = spawnSync(REAL_GIT, ['-C', cSrc, 'cat-file', 'blob', blob], { env: gitEnv, encoding: 'utf8' }).stdout === widened;
  drill = createApp(args, { extraEnv: { FAKE_APP_AS_POSTED: '1' } });
  restoreObjects();
  const forgedPosted = drill.events.find((e) => e.event === 'form');
  ok('control: the forged object gives plain git other bytes for the manifest\'s blob', blobFooled, '');
  ok('a forged object for the manifest\'s blob is ignored: the page posts the committed manifest',
    drill.status === 0 && forgedPosted && JSON.stringify(forgedPosted.manifest.default_permissions) === JSON.stringify(manifest.default_permissions),
    `${cTail(drill)} posted=${forgedPosted && JSON.stringify(forgedPosted.manifest.default_permissions)}`);

  // The entry point refuses a PATH that could find a command in the checkout,
  // before it runs any (review of #27 at 8a9fd87): gh gets the owner's token,
  // and gh or security the key on stdin. Commands planted at the checkout's
  // root (outside governance/, so no content check sees them), run from there.
  const entryRan = path.join(root, 'checks-entry-ran.log');
  const entryPlants = ['gh', 'security', 'bash', 'git', 'env', 'osascript', 'open'];
  for (const n of entryPlants) {
    fs.writeFileSync(path.join(cSrc, n), `#!/bin/sh\necho "${n} token=\${GH_TOKEN-unset}" >> ${JSON.stringify(entryRan)}\ncat >/dev/null\nexit 1\n`, { mode: 0o755 });
  }
  for (const [what, entry] of [['an empty entry', ''], ['a relative entry', 'governance'], ['the checkout itself', cSrc],
    ['the checkout under another letter case', cSrc.toUpperCase()], ['the checkout through the /System/Volumes/Data firmlink', `/System/Volumes/Data${fs.realpathSync(cSrc)}`]]) {
    if (entry.startsWith('/') && entry !== cSrc && !fs.existsSync(entry)) {
      console.log(`ok - # SKIP create-app.py and ${what}: no such alias on this filesystem`);
      continue;
    }
    fs.rmSync(entryRan, { force: true });
    drill = createApp(args, { cwd: cSrc, extraEnv: { PATH: [entry, cBin, SYS_PATH].join(':') } });
    ok(`create-app.py refuses a PATH with ${what} before running anything: nothing planted at the checkout's root runs, no gh call, no page`,
      drill.status !== 0 && /refusing: PATH/.test(drill.stderr) && !fs.existsSync(entryRan) && drill.gh.length === 0 && !drill.opened,
      `${cTail(drill)} ran=${readOr(entryRan).trim()} gh=${drill.gh.length}`);
  }
  fs.rmSync(entryRan, { force: true });
  drill = createApp(args, { cwd: cSrc });
  ok('with a clean PATH, run from the checkout\'s root, create-app.py completes and nothing planted there runs',
    drill.status === 0 && !fs.existsSync(entryRan), `${cTail(drill)} ran=${readOr(entryRan).trim()}`);
  for (const n of entryPlants) fs.rmSync(path.join(cSrc, n), { force: true });
  fs.rmSync(entryRan, { force: true });

  // ---- test is read with nothing from the environment but PATH ----
  const envLog = path.join(cBin, 'canonical-read-env.log');
  fs.writeFileSync(envLog, '');
  const leaky = { HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', SSL_CERT_FILE: '/nonexistent/ca.pem',
    SSL_CERT_DIR: '/nonexistent', CURL_CA_BUNDLE: '/nonexistent/ca.pem', GIT_SSL_NO_VERIFY: '1', MM_UNLISTED_PROBE: 'x',
    GH_TOKEN: 'github_pat_LEAKPROBE', GITHUB_TOKEN: 'github_pat_LEAKPROBE2' };
  drill = createApp(args, { extraEnv: leaky });
  const seen = readOr(envLog).trim().split('\n').filter(Boolean);
  const leaked = seen.flatMap((line) => Object.keys(leaky).filter((k) => line.split(' ').includes(k)));
  ok('the read of test sees none of the proxy, CA or other variables of the environment (env -i, PATH only)',
    drill.status === 0 && seen.length >= 1 && leaked.length === 0, `${cTail(drill)} lines=${seen.length} leaked=${[...new Set(leaked)]}`);
  ok('the read of test runs with GIT_TERMINAL_PROMPT=0, so a private repository fails instead of prompting',
    seen.length >= 1 && seen.every((line) => / GIT_TERMINAL_PROMPT_VALUE=0$/.test(` ${line}`)), seen.map((l) => l.slice(-40)).join(' | '));

  // ---- a planted system gitconfig cannot redirect test either ----
  const sysConfig = path.join(cBin, 'system-gitconfig');
  git(cSrc, 'commit', '-q', '--allow-empty', '-m', 'local, not on test');
  git(cSrc, 'push', '-q', '-f', cEvil, 'HEAD:refs/heads/test');
  fs.writeFileSync(sysConfig, `[url "${cEvil}"]\n\tinsteadOf = ${CANONICAL}\n`);
  const sysControl = spawnSync('git', ['ls-remote', CANONICAL, 'refs/heads/test'], { encoding: 'utf8', env: { PATH: [cBin, SYS_PATH].join(':'), HOME: cHome } });
  drill = createApp(args);
  fs.rmSync(sysConfig, { force: true });
  ok('control: a planted system gitconfig does redirect the canonical URL for an ordinary git call',
    sysControl.stdout.startsWith(git(cSrc, 'rev-parse', 'HEAD')), sysControl.stdout + sysControl.stderr);
  ok('an insteadOf in the system gitconfig pointing test at an unmerged commit is ignored (GIT_CONFIG_NOSYSTEM=1): refused',
    drill.status !== 0 && /not on marvinamiranda\/\.github test/.test(drill.stderr) && !drill.opened && drill.gh.length === 0, `${cTail(drill)} opened=${drill.opened}`);
  git(cSrc, 'reset', '-q', '--hard', merged);

  // ---- an untracked file counts even when git status is told to hide them ----
  git(cSrc, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(cIdentity, 'planted.txt'), 'untracked\n');
  drill = createApp(args);
  fs.rmSync(path.join(cIdentity, 'planted.txt'));
  git(cSrc, 'config', '--unset', 'status.showUntrackedFiles');
  ok('status.showUntrackedFiles=no does not hide an untracked file: refused', drill.status !== 0 && /uncommitted changes/.test(drill.stderr)
    && !drill.opened && drill.gh.length === 0, `${cTail(drill)} opened=${drill.opened}`);

  // ---- refusals: exit non-zero, before the page opens, nothing created ----
  const nothingDone = (x) => x.status !== 0 && !x.opened && x.converted === 0 && x.sets.length === 0 && !fs.existsSync(checksDir());
  for (const [what, a, opts, says] of [
    // Each refusal is identified by its own reason: several guards overlap, and
    // a case that any of them satisfies proves none of them.
    ['mm-checks without --to-environment', ['mm-checks'], {}, /may only go into each repository's governance-checks environment, never onto disk/],
    ['mm-checks with --repo but no --to-environment', ['mm-checks', '--repo', 'prod-a'], {}, /may only go into each repository's governance-checks environment, never onto disk/],
    ['--to-environment with mm-agent', ['mm-agent', '--to-environment', '--repo', 'prod-a'], {}, /only for mm-checks/],
    ['--to-environment with mm-reviewer', ['mm-reviewer', '--to-environment', '--repo', 'prod-a'], {}, /only for mm-checks/],
    ['--to-environment without a --repo', ['mm-checks', '--to-environment'], {}, /--to-environment needs at least one --repo/],
    ['a --repo in another organisation', ['mm-checks', '--to-environment', '--repo', 'someone-else/prod-a'], {}, /marvinamiranda/],
    ['the same --repo twice', ['mm-checks', '--to-environment', '--repo', 'prod-a', '--repo', `${ORG}/prod-a`], {}, /twice/],
    ['a target repository without the governance-checks environment', args, { fx: allRepos({ 'prod-b': { env: 'missing' } }) }, /prod-b[\s\S]*governance-checks/],
    ['an environment that allows protected branches', args, { fx: allRepos({ 'prod-a': { env: 'protected' } }) }, /prod-a[\s\S]*deployment/],
    ['an environment open to every branch', args, { fx: allRepos({ 'prod-a': { env: 'open' } }) }, /prod-a[\s\S]*deployment/],
    ['an environment that also allows refs/pull/*', args,
      { fx: allRepos({ 'prod-a': { rules: [{ id: 1, name: 'test', type: 'branch' }, { id: 2, name: 'refs/pull/*', type: 'branch' }] } }) }, /prod-a[\s\S]*refs\/pull\/\*/],
    ['an environment that also allows *', args,
      { fx: allRepos({ 'prod-b': { rules: [{ id: 1, name: 'test', type: 'branch' }, { id: 3, name: '*', type: 'branch' }] } }) }, /prod-b[\s\S]*\*/],
    ['an environment whose one rule is a tag named test', args,
      { fx: allRepos({ 'prod-a': { rules: [{ id: 1, name: 'test', type: 'tag' }] } }) }, /prod-a/],
    ['an environment with no rule at all', args, { fx: allRepos({ 'prod-a': { rules: [] } }) }, /prod-a/],
    ['a secret already in the environment, without --replace', args, { fx: allRepos({ 'prod-b': { secret: true } }) }, /--replace/],
    ['a shell carrying the Agent App\'s identity', args, { extraEnv: { GH_TOKEN: 'mm-agent-sentinel-not-a-token' } }, /not the owner's credential/],
    ['an installation token as GH_TOKEN', args, { extraEnv: { GH_TOKEN: 'ghs_FAKEINSTALLATIONTOKEN' } }, /not the owner's credential/],
    ['an agent\'s gh config directory', args, { extraEnv: { GH_TOKEN: '', GH_CONFIG_DIR: path.join(cHome, '.config', 'mm-agent', 'mm-agent', 'gh') } }, /not the owner's credential/],
  ]) {
    const x = createApp(a, opts);
    ok(`refuses ${what}: non-zero, before the page opens, nothing created`, nothingDone(x) && says.test(x.stderr), `${cTail(x)} opened=${x.opened} sets=${x.sets.length}`);
  }
  const unknown = createApp(['mm-nobody']);
  ok('refuses an identity it has no custody rule for', nothingDone(unknown), cTail(unknown));

  r = createApp([...args, '--replace'], { fx: allRepos({ 'prod-b': { secret: true } }) });
  ok('with --replace, an existing secret is overwritten, still from stdin',
    r.status === 0 && r.sets.filter((c) => c.stdinSha === PEM_SHA(PEM)).length === REPOS.length && !argvHasKey(r), cTail(r));

  // ---- unchanged: mm-agent's key still goes to its directory ----
  r = createApp(['mm-agent']);
  const agentKey = path.join(cHome, '.config', 'mm-agent', 'mm-agent', 'private-key.pem');
  ok('mm-agent (no flags) still writes its key to ~/.config/mm-agent/mm-agent/private-key.pem, 0600, and uploads nothing',
    r.status === 0 && readOr(agentKey) === PEM && (fs.statSync(agentKey).mode & 0o777) === 0o600 && r.sets.length === 0, cTail(r));
  fs.rmSync(cHome, { recursive: true, force: true }); // that key holds the marker by design

  // ---- a failed upload: says so, names the App to delete, leaves no key ----
  r = createApp(args, { fail: 'prod-b' });
  ok('an upload that fails exits non-zero and names the App to delete',
    r.status !== 0 && /prod-b/.test(r.stderr) && /[Dd]elete/.test(r.stderr) && /fake-checks/.test(r.stderr), cTail(r));
  ok('...and still leaves no key on disk, and prints none',
    filesWithMarker().length === 0 && !fs.existsSync(keyFile()) && !`${r.stdout}${r.stderr}`.includes(MARKER), filesWithMarker().join(', '));

  // ------------------- mm-runners: the key into the login Keychain only ----
  let rManifest = {};
  try { rManifest = JSON.parse(fs.readFileSync(path.join(IDENTITY_SRC, 'mm-runners.manifest.json'), 'utf8')); } catch (e) { rManifest = { default_permissions: {} }; }
  ok('mm-runners.manifest.json: default_permissions is exactly organization_self_hosted_runners write, actions read, metadata read',
    JSON.stringify(Object.entries(rManifest.default_permissions).sort())
      === JSON.stringify([['actions', 'read'], ['metadata', 'read'], ['organization_self_hosted_runners', 'write']]), JSON.stringify(rManifest.default_permissions));
  ok('mm-runners.manifest.json: no webhook, no events, private, named "MarvinaMiranda Runners"',
    rManifest.hook_attributes && rManifest.hook_attributes.active === false && Array.isArray(rManifest.default_events)
      && rManifest.default_events.length === 0 && rManifest.public === false && rManifest.name === 'MarvinaMiranda Runners', JSON.stringify(rManifest));

  const SVC = 'marvinamiranda.ephemeral-runner-pool';
  const runnersDir = () => path.join(cHome, '.config', 'mm-agent', 'mm-runners');
  const secArgvHasKey = (x) => x.sec.some((c) => c.argv.some((a) => a.includes(MARKER) || a.includes(PEM_B64) || a.includes('PRIVATE KEY')));
  const adds = (x) => x.sec.filter((c) => (c.command || c.argv)[0] === 'add-generic-password');
  let k = createApp(['mm-runners', '--to-keychain', SVC]);
  ok('create-app.py mm-runners --to-keychain completes against a stubbed GitHub and a stubbed security',
    k.status === 0 && k.converted === 1 && k.events.some((e) => e.event === 'callback' && e.status === 200), cTail(k));
  const add = adds(k)[0];
  ok('the key reaches security exactly once, as one add-generic-password on stdin (security -i), never in argv',
    adds(k).length === 1 && add.via === 'stdin' && add.argv.includes('-i') && !secArgvHasKey(k), JSON.stringify(k.sec.map((c) => ({ via: c.via, argv: c.argv }))));
  const addCmd = add ? (add.command || add.argv) : []; // command: sent on stdin; argv: passed as arguments
  const pw = addCmd[addCmd.indexOf('-w') + 1];
  ok('...holding the PEM base64-encoded on one line, in the login keychain, service as given, account the client id',
    pw && pw.passwordSha === PEM_SHA(PEM_B64) && addCmd.includes('login.keychain')
      && addCmd[addCmd.indexOf('-s') + 1] === SVC && addCmd[addCmd.indexOf('-a') + 1] === CLIENT_ID
      && !addCmd.includes('-A'), add && add.via);
  ok('...and the Keychain then holds exactly that one item', k.kc.length === 1 && k.kc[0].service === SVC && k.kc[0].account === CLIENT_ID
    && k.kc[0].passwordSha === PEM_SHA(PEM_B64), JSON.stringify(k.kc));
  ok('no file under the temporary tree holds the PEM or its base64', filesWithMarker().length === 0, filesWithMarker().join(', '));
  ok('no private-key.pem for mm-runners, and no temporary file left', !fs.existsSync(path.join(runnersDir(), 'private-key.pem')) && listOr(cTmp).length === 0, listOr(cTmp).join(', '));
  ok('the key is never printed, in either encoding', !`${k.stdout}${k.stderr}`.includes(MARKER) && !`${k.stdout}${k.stderr}`.includes(PEM_B64)
    && k.events.some((e) => e.event === 'callback' && e.marker === false), '');
  const rMeta = readOr(path.join(runnersDir(), 'app.json'));
  let rMetaJson = {};
  try { rMetaJson = JSON.parse(rMeta); } catch (e) { rMetaJson = {}; }
  ok('app.json is exactly { app_id, client_id, slug, keychain_service } and holds no secret',
    JSON.stringify(Object.keys(rMetaJson).sort()) === JSON.stringify(['app_id', 'client_id', 'keychain_service', 'slug'])
      && rMetaJson.app_id === 4242 && rMetaJson.client_id === CLIENT_ID && rMetaJson.keychain_service === SVC && !/PRIVATE KEY|secret/.test(rMeta), rMeta);
  ok('it makes no gh call, and tells the owner to install the App on selected repositories only',
    k.gh.length === 0 && /apps\/fake-checks\/installations\/new/.test(k.stdout) && /[Ss]elect/.test(k.stdout), `gh=${k.gh.length} ${k.stdout.slice(-200)}`);

  // Refusals: non-zero, before the page opens, nothing in the Keychain.
  const kNothing = (x) => x.status !== 0 && !x.opened && x.converted === 0 && adds(x).length === 0 && !fs.existsSync(runnersDir());
  const oldItem = [{ service: SVC, account: 'Iv23.previousapp', keychain: 'login.keychain', passwordSha: 'old' }];
  for (const [what, a, opts, says] of [
    ['mm-runners without --to-keychain', ['mm-runners'], {}, /may only go into the login Keychain/],
    ['--to-keychain with mm-agent', ['mm-agent', '--to-keychain', SVC], {}, /--to-keychain is only for mm-runners/],
    ['--to-keychain with mm-reviewer', ['mm-reviewer', '--to-keychain', SVC], {}, /--to-keychain is only for mm-runners/],
    ['--to-keychain with mm-checks', ['mm-checks', '--to-keychain', SVC], {}, /--to-keychain is only for mm-runners/],
    ['--to-keychain with --to-environment', ['mm-runners', '--to-keychain', SVC, '--to-environment', '--repo', 'prod-a'], {}, /--to-environment is only for mm-checks/],
    ['a service name with a space', ['mm-runners', '--to-keychain', 'bad service'], {}, /service/],
    ['a service name with a quote', ['mm-runners', '--to-keychain', 'svc"x'], {}, /service/],
    ['an existing Keychain item, without --replace', ['mm-runners', '--to-keychain', SVC], { keychain: oldItem }, /--replace/],
  ]) {
    const x = createApp(a, opts);
    ok(`refuses ${what}: non-zero, before the page opens, nothing stored`, kNothing(x) && says.test(x.stderr), `${cTail(x)} opened=${x.opened} adds=${adds(x).length}`);
  }
  ok('the existence check reads no secret: find-generic-password without -w or -g', k.sec.concat(createApp(['mm-runners', '--to-keychain', SVC], { keychain: oldItem }).sec)
    .filter((c) => (c.command || c.argv).includes('find-generic-password')).every((c) => !(c.command || c.argv).includes('-w') && !(c.command || c.argv).includes('-g')), '');

  // --replace: the old item goes, only after the new key is in hand, and the new one is the only one.
  k = createApp(['mm-runners', '--to-keychain', SVC, '--replace'], { keychain: oldItem });
  ok('with --replace, the previous item is deleted and the new key stored: one item, the new App\'s',
    k.status === 0 && k.kc.length === 1 && k.kc[0].account === CLIENT_ID && k.kc[0].passwordSha === PEM_SHA(PEM_B64) && !secArgvHasKey(k), `${cTail(k)} ${JSON.stringify(k.kc)}`);
  k = createApp(['mm-runners', '--to-keychain', SVC, '--replace'], { keychain: oldItem, app: (a) => ({ ...a, owner: { login: 'someone-else', type: 'User' } }) });
  ok('with --replace, an App that is not the manifest\'s leaves the previous item untouched', k.status !== 0 && JSON.stringify(k.kc) === JSON.stringify(oldItem), JSON.stringify(k.kc));

  // The App must be the manifest's before its key is stored.
  k = createApp(['mm-runners', '--to-keychain', SVC], { app: (a) => ({ ...a, permissions: { ...a.permissions, workflows: 'write' } }) });
  ok('an App with a permission the manifest does not ask for: nothing stored, the App named for deletion',
    k.status !== 0 && adds(k).length === 0 && k.kc.length === 0 && /not the one the manifest describes/.test(k.stderr) && filesWithMarker().length === 0, cTail(k));

  // A key too long for one \`security -i\` line (4095 characters): security would
  // split it and echo the remainder as an "unknown command". Refused unsent.
  const bigPem = `-----BEGIN RSA PRIVATE KEY-----\n${MARKER}\n${crypto.randomBytes(3200).toString('base64')}\n-----END RSA PRIVATE KEY-----\n`;
  k = createApp(['mm-runners', '--to-keychain', SVC], { pem: bigPem });
  ok('a key whose security -i line would pass 4000 characters is never sent: nothing stored, the App named for deletion',
    k.status !== 0 && adds(k).length === 0 && k.kc.length === 0 && /[Dd]elete/.test(k.stderr) && !`${k.stdout}${k.stderr}`.includes(Buffer.from(bigPem).toString('base64').slice(0, 40)), cTail(k));

  // security says it stored the key but the item is not there: not trusted.
  k = createApp(['mm-runners', '--to-keychain', SVC], { failKeychainAdd: 'silent' });
  ok('a store that reports success but leaves no item is a failure: no app.json, the App named for deletion',
    k.status !== 0 && /not in the Keychain after the store/.test(k.stderr) && /[Dd]elete/.test(k.stderr) && !fs.existsSync(path.join(runnersDir(), 'app.json')), cTail(k));

  // A store that fails: the recovery always prints, and nothing is left behind.
  k = createApp(['mm-runners', '--to-keychain', SVC], { failKeychainAdd: true });
  ok('a Keychain store that fails exits non-zero, names the App to delete, and leaves no key on disk',
    k.status !== 0 && /[Dd]elete/.test(k.stderr) && /fake-checks/.test(k.stderr) && filesWithMarker().length === 0
      && !`${k.stdout}${k.stderr}`.includes(PEM_B64) && !fs.existsSync(path.join(runnersDir(), 'app.json')), cTail(k));
})();

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
