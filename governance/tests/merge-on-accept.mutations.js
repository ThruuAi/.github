#!/usr/bin/env node
'use strict';

// Mutation proof for governance/tests/merge-on-accept.test.js (ThruuAi/.github#22): each mutant breaks one
// rule of the judge or the workflow, and the suite must go red on every one. A mutant that survives, or
// that did not land (its text was not found), fails this script.
//
//   node governance/tests/merge-on-accept.mutations.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'governance', 'merge-on-accept.js');
const WF = path.join(ROOT, '.github', 'workflows', 'merge-on-accept.yml');
const SUITE = path.join(__dirname, 'merge-on-accept.test.js');

const mutants = [
  ['lib', 'any commenter may merge', 'return WRITE_ROLES.has(String(role).toLowerCase());', 'return true;'],
  ['lib', 'an edited ACCEPT counts', "if (accept.updated_at && accept.created_at && accept.updated_at !== accept.created_at)", 'if (false)'],
  ['lib', 'a head with another tree is carried', 'if (cHead.tree.sha !== cSha.tree.sha || parents.length', 'if (parents.length'],
  ['lib', 'a same-tree head on another parent is carried', '|| parents[0] !== sha)', ')'],
  ['lib', 'a reader\'s verdict counts', 'if (await isWriter(x.c.user && x.c.user.login)) counted.push(x);', 'counted.push(x);'],
  ['lib', 'the recheck ignores a newer CHANGES', "if (!lv.last || lv.last.v.verdict !== 'ACCEPT' || lv.last.c.id !== verdict.acceptId) return", 'if (false) return'],
  ['lib', 'a promotion is squashed', "if (base === 'test' || base === 'main') return 'merge';", ''],
  ['lib', 'CHANGES after ACCEPT is ignored', "if (lastVerdict.v.verdict !== 'ACCEPT')", 'if (false)'],
  ['lib', 'an ACCEPT after the command counts', 'c.id < beforeId', 'true'],
  ['lib', 'done-in-dev grammar loses its word boundary', 'const re = /\\b(?:close', 'const re = /(?:close'],
  ['wf', 'a retry ignores a PR changed meanwhile', "if (!pr || pr.state !== 'open' || pr.draft || held ||", 'if (false ||'],
  ['wf', 'done in dev skips an issue GitHub already closed', "if (issue.state === 'closed' && issue.state_reason !== 'completed') continue;", "if (issue.state !== 'open') continue;"],
  ['lib', 'the hold label is ignored', 'if ((pr.labels || []).some(', 'if (false && (pr.labels || []).some('],
  ['lib', 'a draft merges', "if (pr.draft) return", 'if (false) return'],
  ['lib', 'main is allowed', "(policy.bases || ['dev', 'test']).includes(base)", 'true'],
  ['lib', 'a foreign App may impersonate a pinned check', "&& r.id > pick.id)) return 'refused", "&& false)) return 'refused"],
  ['lib', 'running checks are ignored', 'if (others.pending.length) return', 'if (false) return'],
  ['lib', 'failed commit statuses are ignored', 'if (st.bad.length) return', 'if (false) return'],
  ['lib', 'the stale gate ignores a moved base', 'if (B !== D) return', 'if (false) return'],
  ['lib', 'the recheck ignores a moved head', 'if (pr.head.sha !== verdict.headSha) return', 'if (false) return'],
  ['wf', 'the merge is not bound to the judged head', 'sha: v.headSha, merge_method: v.method', 'merge_method: v.method'],
  ['wf', 'the PR head is checked out', 'ref: ${{ inputs.governance-ref }}\n          path: .org-governance', 'ref: ${{ github.event.issue.number }}\n          path: .org-governance'],
  ['wf', 'the recheck step is skipped', "if: steps.review.outputs.posted == 'true'\n        uses", "if: false\n        uses"],
  ['wf', 'an expression in a script', "const temp = process.env.RUNNER_TEMP;\n            const v = JSON.parse(fs.readFileSync(path.join(temp, 'merge-verdict.json'), 'utf8'));\n            const { owner, repo } = context.repo;\n            try {",
    "const temp = process.env.RUNNER_TEMP;\n            const v = JSON.parse(fs.readFileSync(path.join(temp, 'merge-verdict.json'), 'utf8'));\n            const { owner, repo } = context.repo; const b = '${{ github.event.comment.body }}';\n            try {"],
  ['wf', 'the Reviewer token can write contents', "permission-checks: write\n\n      # Inline", "permission-checks: write\n          permission-contents: write\n\n      # Inline"],
  ['wf', 'any App id is accepted', "if (process.env.AGENT_APP_ID !== '5075705' || process.env.REVIEWER_APP_ID !== '5075711')", 'if (false)'],
  ['wf', 'the runner is not checked', "if (pattern && !new RegExp(pattern).test(process.env.RUNNER_NAME || ''))", 'if (false)'],
  ['lib', 'a permission outage drops a CHANGES', "if (strict && !(error && error.status === 404)) throw error;", ''],
  ['wf', 'a refusal is not reported', "if: always() && needs.merge.result != 'skipped'", "if: needs.merge.result == 'success'"],
  ['wf', 'the merge job can comment', "      contents: read\n      issues: read\n      pull-requests: read", "      contents: read\n      issues: write\n      pull-requests: write"],
  ['wf', 'the report job gets more than pull-requests: write', "    permissions:\n      pull-requests: write\n", "    permissions:\n      pull-requests: write\n      contents: write\n"],
  ['wf', 'the result is not published on a refusal', "        id: result\n        if: always()", "        id: result\n        if: steps.merge.outputs.merged == 'true'"],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-on-accept-mut-'));
let bad = 0;
for (const [where, name, from, to] of mutants) {
  const src = where === 'lib' ? LIB : WF;
  const text = fs.readFileSync(src, 'utf8');
  if (!text.includes(from)) { console.log(`not ok - mutant did not land: ${name}`); bad += 1; continue; }
  const out = path.join(dir, path.basename(src));
  fs.writeFileSync(out, text.replace(from, to));
  if (fs.readFileSync(out, 'utf8') === text) { console.log(`not ok - mutant changed nothing: ${name}`); bad += 1; continue; }
  const env = { ...process.env, [where === 'lib' ? 'MERGE_ON_ACCEPT_LIB' : 'MERGE_ON_ACCEPT_WORKFLOW']: out };
  const run = spawnSync('node', [SUITE], { env, encoding: 'utf8' });
  if (run.status === 0) { console.log(`not ok - mutant survived: ${name}`); bad += 1; } else console.log(`ok - killed: ${name}`);
}
console.log(`\n${mutants.length - bad}/${mutants.length} mutants killed`);
process.exit(bad ? 1 : 0);
