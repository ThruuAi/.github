'use strict';

// governance/merge-on-accept.js: the judge behind .github/workflows/merge-on-accept.yml
// (ThruuAi/.github#22). It replaces the checks of the Mac-only merge-pr.sh so a
// cloud lead can merge with a `/merge <sha>` comment.
//
// It only READS. It runs inside actions/github-script holding the job's read
// GITHUB_TOKEN, and it never sees an App key or an App token. The steps that
// post `review/independent` and merge are inline text of the workflow, and they
// act only on the verdict this module returns.
//
// judge()    is called before anything is posted. It returns { ok: false, reason }
//            or { ok: true, ... } with the PR, the head to merge, the method and the
//            accepting comment.
// recheck()  is called after `review/independent` is posted and right before the
//            merge. The head must be unchanged, and every required check, now
//            including `review/independent`, must be success.
//
// Every rule fails closed: an answer it cannot read refuses the merge.

const SHA = /^[0-9a-f]{40}$/;
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);
const BAD = new Set(['failure', 'timed_out', 'action_required', 'neutral', 'cancelled', 'stale', 'startup_failure']);
// The Checks App posts a same-named shadow of the PR gate that can fail on a broken secret (incident #1671).
// It is ignored only when the GitHub Actions copy of the same check succeeded on the same head, as in merge-pr.sh.
const SHADOW_APP = 'marvinamiranda-checks';
const REVIEW_CHECK = 'review/independent';
// Fails while a PR is a draft and never re-runs once it is ready (merge-pr.sh skips it the same way).
const DRAFT_GATE = 'required draft';
const HOLD_LABEL = 'hold';
const CAP = 3000;

const cap = (text) => {
  const s = String(text == null ? '' : text);
  return s.length <= CAP ? s : `${s.slice(0, CAP - 20)}\n\n(truncated)`;
};
const httpStatus = (error) => (error && Number.isInteger(error.status) ? `HTTP ${error.status}` : 'an error');

// The command: exactly `/merge <40-character sha>` on the first non-empty line, and nothing else on it.
function parseCommand(body) {
  const first = String(body || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  const m = /^\/merge[ \t]+([0-9a-f]{40})$/.exec(first);
  return m ? m[1] : null;
}

// A review verdict: one line `REVIEW ACCEPT <sha40>` or `REVIEW CHANGES <sha40>`, then optional text.
// A comment with more than one verdict line is ambiguous, so it counts as none.
function parseVerdict(body) {
  const found = [];
  for (const line of String(body || '').replace(/\r/g, '').split('\n')) {
    const m = /^REVIEW (ACCEPT|CHANGES) ([0-9a-f]{40})(?:\s|$)/.exec(line.trim());
    if (m) found.push({ verdict: m[1], sha: m[2] });
  }
  return found.length === 1 ? found[0] : null;
}

// "Closes #12", "Fixes owner/repo#12", "Resolves https://github.com/owner/repo/issues/12" (the done-in-dev.sh grammar).
function closingRefs(body, owner, repo) {
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[: ]+((?:https:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#|\/issues\/)[0-9]+|#[0-9]+)/gi;
  const out = new Map();
  for (const m of String(body || '').matchAll(re)) {
    const ref = m[1].replace(/^https:\/\/github\.com\//i, '').replace('/issues/', '#');
    let o = owner; let r = repo; let n;
    if (ref.startsWith('#')) n = Number(ref.slice(1));
    else { [o, r] = ref.split('#')[0].split('/'); n = Number(ref.split('#')[1]); }
    if (Number.isSafeInteger(n) && n > 0) out.set(`${o}/${r}#${n}`.toLowerCase(), { owner: o, repo: r, number: n });
  }
  return [...out.values()];
}

// true or false; with `strict`, an answer other than a role or a 404 throws, so a caller that must not read an
// outage as "not a writer" (dropping a writer's CHANGES) can refuse instead.
async function hasWrite(github, owner, repo, login, { strict = false } = {}) {
  if (typeof login !== 'string' || login.length === 0) return false;
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login });
    const role = (data && (data.role_name || data.permission)) || '';
    return WRITE_ROLES.has(String(role).toLowerCase());
  } catch (error) {
    if (strict && !(error && error.status === 404)) throw error;
    return false;
  }
}

// The required checks of the base branch's rulesets, each with the App GitHub pins it to (integration_id), when any.
// `extra` is the caller's pinned set, for a branch with no ruleset (the Mac's state/required-checks.tsv).
async function requiredChecks(github, owner, repo, base, extra) {
  let rules;
  try {
    ({ data: rules } = await github.rest.repos.getBranchRules({ owner, repo, branch: base, per_page: 100 }));
  } catch (error) {
    return { error: `Could not read the rules of ${base} (${httpStatus(error)}).` };
  }
  if (!Array.isArray(rules)) return { error: `The rules of ${base} are unreadable.` };
  const map = new Map();
  for (const rule of rules) {
    if (!rule || rule.type !== 'required_status_checks') continue;
    const list = rule.parameters && rule.parameters.required_status_checks;
    if (!Array.isArray(list)) return { error: `A required-checks rule of ${base} is unreadable.` };
    for (const c of list) {
      if (!c || typeof c.context !== 'string' || c.context.length === 0) return { error: `A required check of ${base} has no name.` };
      const pin = Number.isSafeInteger(c.integration_id) ? c.integration_id : null;
      if (map.has(c.context) && map.get(c.context) !== pin) return { error: `Required check '${c.context}' is pinned to two different Apps.` };
      map.set(c.context, pin);
    }
  }
  for (const name of extra || []) if (!map.has(name)) map.set(name, null);
  if (map.size === 0) return { error: `No required checks are readable for ${base} (no ruleset and no pinned set), so nothing proves the head is green.` };
  return { checks: [...map].map(([name, appId]) => ({ name, appId })) };
}

async function checkRuns(github, owner, repo, ref) {
  try {
    const runs = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref, per_page: 100 });
    if (!Array.isArray(runs)) return { error: 'The check runs are unreadable.' };
    return { runs };
  } catch (error) {
    return { error: `Could not read the check runs on ${ref.slice(0, 8)} (${httpStatus(error)}).` };
  }
}

const appSlug = (r) => (r && r.app && r.app.slug) || '';
const appId = (r) => (r && r.app && r.app.id) || null;
const newest = (list) => list.slice().sort((a, b) => a.id - b.id).pop();

// The verdict of one required check from its runs: success, pending, missing or a conclusion.
function requiredVerdict(runs, check) {
  const named = runs.filter((r) => r && r.name === check.name);
  let pick;
  if (check.appId !== null) {
    const own = named.filter((r) => appId(r) === check.appId);
    pick = newest(own);
    if (!pick) return `missing (no run by the pinned App ${check.appId})`;
    // A newer same-name run from another App (other than the GitHub Actions mirror) is an impersonation attempt.
    if (named.some((r) => appId(r) !== check.appId && appSlug(r) !== 'github-actions' && r.id > pick.id)) return 'refused (a newer run of the same name from another App)';
  } else {
    const actionsOk = named.some((r) => appSlug(r) === 'github-actions' && r.conclusion === 'success');
    pick = newest(named.filter((r) => appSlug(r) !== SHADOW_APP || !actionsOk));
    if (!pick) return 'missing';
  }
  if (pick.status !== 'completed') return 'pending';
  return pick.conclusion || 'none';
}

// The newest run of every check name (shadow rule applied) that did not succeed, and the runs still going.
function otherRuns(runs, { includeReview }) {
  const actionsOk = new Set(runs.filter((r) => appSlug(r) === 'github-actions' && r.conclusion === 'success').map((r) => r.name));
  const groups = new Map();
  for (const r of runs) {
    if (!r || r.name === DRAFT_GATE) continue;
    if (!includeReview && r.name === REVIEW_CHECK) continue;
    if (appSlug(r) === SHADOW_APP && actionsOk.has(r.name)) continue;
    groups.set(r.name, [...(groups.get(r.name) || []), r]);
  }
  const pending = []; const bad = [];
  for (const [name, list] of groups) {
    const last = newest(list);
    if (last.status !== 'completed') pending.push(name);
    else if (BAD.has(last.conclusion)) bad.push(`${name}=${last.conclusion}`);
  }
  return { pending: pending.sort(), bad: bad.sort() };
}

async function failingStatuses(github, owner, repo, ref) {
  try {
    const { data } = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100 });
    const statuses = (data && data.statuses) || [];
    return { bad: statuses.filter((s) => s.state === 'failure' || s.state === 'error').map((s) => s.context).sort() };
  } catch (error) {
    return { error: `Could not read the commit statuses on ${ref.slice(0, 8)} (${httpStatus(error)}).` };
  }
}

// #849, ported from gate-base.sh: the newest successful gate must have tested the merge ref GitHub built on the
// CURRENT base head. Policy 'on' or 'off' comes from the caller (a repository variable), so it can be switched
// without a code change. Fails closed. The ci-full mode of gate-base.sh is not ported: a PR that uses it is refused.
async function staleGate(github, owner, repo, pr, head, policy) {
  const flag = String(policy.staleGate || '').toLowerCase();
  if (['off', 'false', 'no', '0'].includes(flag)) return '';
  if (!['on', 'true', 'yes', '1'].includes(flag)) return `The stale-gate policy '${policy.staleGate}' is not on or off (failing closed).`;
  const gate = policy.gateCheck || 'gate';
  if (/ci[^A-Za-z0-9]*full[^A-Za-z0-9]*pass/i.test(pr.body || '')) {
    return 'The PR body carries a ci-full line; the ci-full mode of the stale-gate rule is not ported to CI. Merge it from the Mac, or remove the line and gate it on the current base.';
  }
  try {
    const { data: baseRef } = await github.rest.git.getRef({ owner, repo, ref: `heads/${pr.base.ref}` });
    const { data: mergeRef } = await github.rest.git.getRef({ owner, repo, ref: `pull/${pr.number}/merge` });
    const D = baseRef && baseRef.object && baseRef.object.sha;
    const M = mergeRef && mergeRef.object && mergeRef.object.sha;
    if (!SHA.test(D || '') || !SHA.test(M || '')) return 'The base head or the PR merge ref is unreadable (stale-gate rule).';
    const { data: mc } = await github.rest.git.getCommit({ owner, repo, commit_sha: M });
    const B = mc && mc.parents && mc.parents[0] && mc.parents[0].sha;
    const MH = mc && mc.parents && mc.parents[1] && mc.parents[1].sha;
    const mdate = mc && mc.committer && mc.committer.date;
    if (!SHA.test(B || '') || MH !== head || !mdate) return `The current merge ref is not (base, ${head.slice(0, 8)}); re-run the '${gate}' check on the current merge ref.`;
    const got = await checkRuns(github, owner, repo, head);
    if (got.error) return got.error;
    const ok = newest(got.runs.filter((r) => r.name === gate && r.status === 'completed' && r.conclusion === 'success'));
    if (!ok) return `No successful '${gate}' run on ${head.slice(0, 8)}, which the stale-gate rule needs.`;
    const suiteId = ok.check_suite && ok.check_suite.id;
    if (!Number.isSafeInteger(suiteId)) return `The '${gate}' run has no check suite, so it cannot be bound to the merge ref.`;
    const { data: suite } = await github.rest.checks.getSuite({ owner, repo, check_suite_id: suiteId });
    const started = suite && suite.created_at;
    if (!started || !(Date.parse(started) > Date.parse(mdate))) {
      return `The newest successful '${gate}' (suite created ${started || '?'}) did not start after the merge ref was built (${mdate}): it did not test the current ${pr.base.ref}. Re-run it and merge again.`;
    }
    if (B !== D) return `The '${gate}' check tested ${pr.base.ref}@${B.slice(0, 8)}, but ${pr.base.ref} is now ${D.slice(0, 8)}. Re-run it on the current merge ref and merge again.`;
    return '';
  } catch (error) {
    return `The stale-gate rule could not read what it needs (${httpStatus(error)}), so it refuses.`;
  }
}

// What judge() and recheck() both require of the PR as it is now.
function prProblem(pr, policy) {
  if (!pr || !Number.isSafeInteger(pr.number)) return 'The pull request is unreadable.';
  if (pr.state !== 'open') return `The pull request is ${pr.merged ? 'already merged' : pr.state}.`;
  if (pr.draft) return 'The pull request is a draft. Mark it ready, then comment /merge again.';
  const base = pr.base && pr.base.ref;
  if (!(policy.bases || ['dev', 'test']).includes(base)) return `The base is '${base}'. This workflow merges into ${(policy.bases || ['dev', 'test']).join(' or ')} only; main and uat stay with the owner.`;
  if (!pr.head || !pr.head.repo || !pr.base.repo || pr.head.repo.id !== pr.base.repo.id) return 'The head branch is not in this repository (a fork). It cannot be merged this way.';
  if (!SHA.test(pr.head.sha || '')) return 'The PR head is unreadable.';
  if ((pr.labels || []).some((l) => String((l && l.name) || l).toLowerCase() === HOLD_LABEL)) return `The pull request has the '${HOLD_LABEL}' label.`;
  return '';
}

async function checksProblem(github, owner, repo, pr, head, policy, { includeReview }) {
  const req = await requiredChecks(github, owner, repo, pr.base.ref, policy.requiredChecks);
  if (req.error) return req.error;
  const got = await checkRuns(github, owner, repo, head);
  if (got.error) return got.error;
  const notOk = [];
  for (const check of req.checks) {
    if (!includeReview && check.name === REVIEW_CHECK) continue;
    const v = requiredVerdict(got.runs, check);
    if (v !== 'success') notOk.push(`${check.name}: ${v}`);
  }
  if (notOk.length) return `Required checks are not success on ${head.slice(0, 8)}: ${notOk.join('; ')}.`;
  const others = otherRuns(got.runs, { includeReview });
  if (others.pending.length) return `Checks are still running on ${head.slice(0, 8)} (${others.pending.join(', ')}). Comment /merge again when they finish.`;
  if (others.bad.length) return `Checks failed on ${head.slice(0, 8)}: ${others.bad.join(', ')}.`;
  const st = await failingStatuses(github, owner, repo, head);
  if (st.error) return st.error;
  if (st.bad.length) return `Commit statuses failed on ${head.slice(0, 8)}: ${st.bad.join(', ')}.`;
  return staleGate(github, owner, repo, pr, head, policy);
}

async function readPr(github, owner, repo, number) {
  try {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    return { pr: data };
  } catch (error) {
    return { error: `Could not read pull request #${number} (${httpStatus(error)}).` };
  }
}

async function commitOf(github, owner, repo, sha) {
  try {
    const { data } = await github.rest.git.getCommit({ owner, repo, commit_sha: sha });
    return data && data.tree && data.tree.sha ? data : null;
  } catch (error) {
    return null;
  }
}

// The latest review verdict for `sha` among the comments posted before `beforeId`, by authors with write access
// only (a reader cannot block a merge with a CHANGES comment, nor approve one with an ACCEPT).
async function latestVerdict(github, owner, repo, prNumber, sha, beforeId) {
  let comments;
  try {
    comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 });
  } catch (error) {
    return { error: `Could not read the comments of #${prNumber} (${httpStatus(error)}).` };
  }
  const writers = new Map();
  const isWriter = async (login) => {
    if (!writers.has(login)) writers.set(login, await hasWrite(github, owner, repo, login, { strict: true }));
    return writers.get(login);
  };
  const candidates = comments
    .filter((c) => c && Number.isSafeInteger(c.id) && c.id < beforeId)
    .map((c) => ({ c, v: parseVerdict(c.body) }))
    .filter((x) => x.v && x.v.sha === sha)
    .sort((a, b) => a.c.id - b.c.id);
  const counted = [];
  try {
    for (const x of candidates) if (await isWriter(x.c.user && x.c.user.login)) counted.push(x);
  } catch (error) {
    return { error: `Could not read a reviewer's permission (${httpStatus(error)}), so the verdicts cannot be weighed.` };
  }
  return { last: counted.pop() || null };
}

function mergeMethod(base, policy) {
  if (base === 'test' || base === 'main') return 'merge'; // promotions keep dev an ancestor of test
  const m = String(policy.devMergeMethod || 'squash').toLowerCase();
  return ['squash', 'merge'].includes(m) ? m : null;
}

async function judge({ github, owner, repo, prNumber, comment, policy = {} }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!comment || typeof comment.body !== 'string') return fail('The comment is unreadable.');
  const sha = parseCommand(comment.body);
  if (!sha) return fail('The command must be exactly `/merge <40-character sha>` on the first line.');
  const login = comment.user && comment.user.login;
  if (!(await hasWrite(github, owner, repo, login))) return fail(`${login || 'The commenter'} does not have write access to ${owner}/${repo}, so the command is ignored.`);

  const read = await readPr(github, owner, repo, prNumber);
  if (read.error) return fail(read.error);
  const { pr } = read;
  const problem = prProblem(pr, policy);
  if (problem) return fail(problem);
  const method = mergeMethod(pr.base.ref, policy);
  if (!method) return fail(`The dev merge method '${policy.devMergeMethod}' is not squash or merge.`);

  // The head must be the sha named, or an empty "re-run checks" commit on top of it: one parent, the reviewed
  // sha, and the same tree. A same-tree commit on another parent (a newer base) could still drop the base's
  // changes when merged, so it is not carried.
  const head = pr.head.sha;
  let carried = false;
  if (head !== sha) {
    const [cHead, cSha] = await Promise.all([commitOf(github, owner, repo, head), commitOf(github, owner, repo, sha)]);
    if (!cHead || !cSha) return fail(`Could not read the commits ${head.slice(0, 8)} and ${sha.slice(0, 8)}.`);
    const parents = (cHead.parents || []).map((p) => p && p.sha);
    if (cHead.tree.sha !== cSha.tree.sha || parents.length !== 1 || parents[0] !== sha) {
      return fail(`The head moved to ${head.slice(0, 8)} since ${sha.slice(0, 8)}, and it is not an empty commit on top of it. Review the new head, then comment /merge <new sha>.`);
    }
    carried = true;
  }

  // The accepting review: the latest verdict for this sha by a writer, posted before this command, is an
  // unedited comment `REVIEW ACCEPT <sha>`.
  const lv = await latestVerdict(github, owner, repo, prNumber, sha, comment.id);
  if (lv.error) return fail(lv.error);
  const lastVerdict = lv.last;
  if (!lastVerdict) return fail(`No \`REVIEW ACCEPT ${sha}\` comment by someone with write access was posted before this command.`);
  if (lastVerdict.v.verdict !== 'ACCEPT') return fail(`The latest review of ${sha.slice(0, 8)} asks for changes (${lastVerdict.c.html_url || 'comment'}).`);
  const accept = lastVerdict.c;
  if (accept.updated_at && accept.created_at && accept.updated_at !== accept.created_at) return fail(`The ACCEPT comment was edited after it was posted (${accept.html_url || 'comment'}); post a new one.`);
  const reviewer = accept.user && accept.user.login;

  const checks = await checksProblem(github, owner, repo, pr, head, policy, { includeReview: false });
  if (checks) return fail(checks);

  const summary = cap(`${String(accept.body || '').trim()}\n\nAccepted in ${accept.html_url || 'a PR comment'} by ${reviewer}; merged on /merge by ${login}.`
    + (carried ? ` Carried to ${head.slice(0, 8)}: same tree as reviewed ${sha.slice(0, 8)}.` : ''));
  return {
    ok: true, pr: pr.number, base: pr.base.ref, headSha: head, reviewedSha: sha, carried, method,
    title: pr.title, body: pr.body || '', reviewer, commander: login, acceptUrl: accept.html_url || '', acceptId: accept.id,
    commandId: comment.id, summary,
  };
}

async function recheck({ github, owner, repo, verdict, policy = {} }) {
  const read = await readPr(github, owner, repo, verdict.pr);
  if (read.error) return read.error;
  const { pr } = read;
  const problem = prProblem(pr, policy);
  if (problem) return problem;
  if (pr.head.sha !== verdict.headSha) return `The head moved from ${verdict.headSha.slice(0, 8)} to ${pr.head.sha.slice(0, 8)} while the merge was prepared.`;
  if (pr.base.ref !== verdict.base) return `The base changed from ${verdict.base} to ${pr.base.ref} while the merge was prepared.`;
  // A writer's REVIEW CHANGES posted since the judge (any time before now) stops the merge.
  const lv = await latestVerdict(github, owner, repo, verdict.pr, verdict.reviewedSha, Number.MAX_SAFE_INTEGER);
  if (lv.error) return lv.error;
  if (!lv.last || lv.last.v.verdict !== 'ACCEPT' || lv.last.c.id !== verdict.acceptId) return `A newer review of ${verdict.reviewedSha.slice(0, 8)} was posted while the merge was prepared.`;
  return checksProblem(github, owner, repo, pr, verdict.headSha, policy, { includeReview: true });
}

module.exports = { parseCommand, parseVerdict, closingRefs, judge, recheck, requiredVerdict, otherRuns, REVIEW_CHECK };
