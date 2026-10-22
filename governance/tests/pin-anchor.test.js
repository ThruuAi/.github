#!/usr/bin/env node
'use strict';

// The trust root of the governance workflows is ThruuAi/.github `test`
// (omni237#2629: ThruuAi is the home organisation). Each reusable workflow
// verifies, before it fetches any code, that it runs from that repository and
// that its pin is a commit of that repository's `test`. Those anchors are
// hard-coded on purpose; this suite pins WHERE, and goes red if any of them
// names another repository, including the former root marvinamiranda/.github.
//
//   node governance/tests/pin-anchor.test.js
//
// pr-governance.test.js and issue-link-publish.test.js prove the BEHAVIOUR of
// the pin check. This one is text-level and covers all three workflows that
// carry the check (source-policy.yml has no behavioural suite of its own), and
// proves itself by mutation: every anchor, one occurrence at a time, is pointed
// at another repository and the analysis must report it.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', '.github', 'workflows');
// workflow -> number of pin blocks (one per job that verifies the pin) and checkouts.
const EXPECT = {
  'issue-link-publish.yml': { pins: 1, checkouts: 1 },
  'pr-governance.yml': { pins: 2, checkouts: 2 },
  'source-policy.yml': { pins: 1, checkouts: 1 },
};

let failed = 0;
let total = 0;
function ok(name, condition, detail = '') {
  total += 1;
  if (condition) console.log(`ok - ${name}`);
  else { failed += 1; console.log(`not ok - ${name}${detail ? `: ${detail}` : ''}`); }
}

const ANCHORS = {
  selfRepository: /\.toLowerCase\(\) !== '([^']*)'\)/g,
  branchOwner: /getBranch\(\{ owner: '([^']*)', repo: '([^']*)', branch: '([^']*)' \}\)/g,
  compareOwner: /compareCommitsWithBasehead\(\{\s*owner: '([^']*)', repo: '([^']*)'/g,
  // Each actions/checkout step; only those naming a `repository:` fetch governance code (the areas job also checks out the caller, for its own file).
  checkout: /uses: actions\/checkout@[^\n]*\n(?:(?!\n\s*- )[^\n]*\n?)*/g,
};
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// Returns the list of things wrong with one workflow's anchors.
function analyse(name, text) {
  const want = EXPECT[name];
  const body = code(text);
  const problems = [];
  const all = (re) => [...body.matchAll(re)];
  const selfRepo = all(ANCHORS.selfRepository);
  if (selfRepo.length !== want.pins) problems.push(`${selfRepo.length} workflow_repository comparisons, expected ${want.pins}`);
  for (const m of selfRepo) if (m[1] !== 'thruuai/.github') problems.push(`workflow_repository is compared with '${m[1]}', not 'thruuai/.github'`);
  for (const [label, re] of [['getBranch', ANCHORS.branchOwner], ['compare', ANCHORS.compareOwner]]) {
    const found = all(re);
    if (found.length !== want.pins) problems.push(`${found.length} ${label} calls, expected ${want.pins}`);
    for (const m of found) {
      if (m[1] !== 'ThruuAi' || m[2] !== '.github') problems.push(`${label} reads ${m[1]}/${m[2]}, not ThruuAi/.github`);
      if (label === 'getBranch' && m[3] !== 'test') problems.push(`getBranch reads branch '${m[3]}', not 'test'`);
    }
  }
  const checkouts = all(ANCHORS.checkout).map((m) => [m[0], ((m[0].match(/^\s*repository: (\S+)\s*$/m) || [])[1])]).filter(([, repo]) => repo);
  if (checkouts.length !== want.checkouts) problems.push(`${checkouts.length} governance checkouts, expected ${want.checkouts}`);
  for (const [, repo] of checkouts) if (repo !== 'ThruuAi/.github') problems.push(`checks out ${repo}, not ThruuAi/.github`);
  // Nothing executable may name the former organisation at all.
  const stray = body.split('\n').filter((l) => /marvinamiranda/i.test(l));
  if (stray.length) problems.push(`non-comment lines name marvinamiranda: ${stray.map((l) => l.trim().slice(0, 80)).join(' | ')}`);
  // The failure message names the repository it expects.
  if (!body.includes('not ThruuAi/.github.')) problems.push("the 'not ThruuAi/.github.' message is missing");
  return problems;
}

const sources = Object.fromEntries(Object.keys(EXPECT).map((n) => [n, fs.readFileSync(path.join(DIR, n), 'utf8')]));

for (const name of Object.keys(EXPECT)) {
  const problems = analyse(name, sources[name]);
  ok(`${name}: every pin anchor is ThruuAi/.github test`, problems.length === 0, problems.join('; '));
}

// The three workflows carry the same verify-pin block, character for character.
const block = (t) => {
  const m = t.match(/\/\/ BEGIN verify-pin[^\n]*\n([\s\S]*?)\n[ \t]*\/\/ END verify-pin/);
  return m ? m[1].split('\n').map((l) => l.trim()).join('\n') : null;
};
const blocks = Object.fromEntries(Object.keys(EXPECT).map((n) => [n, block(sources[n])]));
ok('the verify-pin block is present in every workflow', Object.values(blocks).every((b) => b), JSON.stringify(Object.entries(blocks).map(([k, v]) => [k, v === null])));
ok('the verify-pin block is identical across the three workflows', new Set(Object.values(blocks)).size === 1);

// ------------------------------------------------ mutation proof -----------
// Each mutant rewrites ONE occurrence of an anchor; analyse() must report it.
const mutations = [
  ['workflow_repository compared with the former root', /(\.toLowerCase\(\) !== ')thruuai\/\.github('\))/g, '$1marvinamiranda/.github$2'],
  ['workflow_repository compared with a lookalike', /(\.toLowerCase\(\) !== ')thruuai\/\.github('\))/g, '$1thruuai/.github-evil$2'],
  ['workflow_repository compared in mixed case (always unequal after toLowerCase)', /(\.toLowerCase\(\) !== ')thruuai\/\.github('\))/g, '$1ThruuAi/.github$2'],
  ['the branch read from the former root', /(getBranch\(\{ owner: ')ThruuAi(')/g, '$1marvinamiranda$2'],
  ['the branch read from another repository', /(getBranch\(\{ owner: 'ThruuAi', repo: ')\.github(')/g, '$1elsewhere$2'],
  ['the branch read is not test', /(branch: ')test(' \}\))/g, '$1dev$2'],
  ['the compare made against the former root', /(compareCommitsWithBasehead\(\{\s*owner: ')ThruuAi(')/g, '$1marvinamiranda$2'],
  ['the compare made against another repository', /(compareCommitsWithBasehead\(\{\s*owner: 'ThruuAi', repo: ')\.github(')/g, '$1elsewhere$2'],
  ['the matcher checked out from the former root', /^(\s*repository: )ThruuAi\/\.github(\s*)$/gm, '$1marvinamiranda/.github$2'],
  ['the matcher checked out from a fork', /^(\s*repository: )ThruuAi\/\.github(\s*)$/gm, '$1someone/.github$2'],
  ['the workflow_repository comparison removed', /if \(\(env\.SELF_REPOSITORY \|\| ''\)\.toLowerCase\(\) !== 'thruuai\/\.github'\) \{/g, 'if (false) {'],
];

const nth = (text, re, n, repl) => {
  let i = -1;
  return text.replace(re, (...args) => {
    i += 1;
    if (i !== n) return args[0];
    // Expand $1/$2 in repl against the match groups.
    return repl.replace(/\$(\d)/g, (_, g) => args[Number(g)] || '');
  });
};
const count = (text, re) => (text.match(re) || []).length;

for (const [label, re, repl] of mutations) {
  let applied = 0;
  const missed = [];
  for (const name of Object.keys(EXPECT)) {
    const n = count(sources[name], re);
    for (let i = 0; i < n; i += 1) {
      const mutated = nth(sources[name], re, i, repl);
      applied += 1;
      if (mutated === sources[name]) { missed.push(`${name}#${i}: no change`); continue; }
      if (analyse(name, mutated).length === 0) missed.push(`${name}#${i}`);
    }
  }
  ok(`mutant: ${label} (${applied} sites) turns the analysis red`, applied > 0 && missed.length === 0, applied === 0 ? 'the mutation matched nothing' : `survived: ${missed.join(', ')}`);
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
