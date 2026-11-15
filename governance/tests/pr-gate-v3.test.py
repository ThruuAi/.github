#!/usr/bin/env python3
"""Tests for .github/workflows/dotnet-pr-v3.yml: the gate a pull request meets depends on the branch it targets.

  into dev          the lane alone;
  into test / main  the lane running everything, plus the caller's `shards-test` matrix of test shards;
  into uat          the same with `shards-uat` (the whole suite).

What is pinned:

  * the shape: jobs lane, plan, shard, ci; the verdict `ci` runs ALWAYS (a skipped required check counts as passed) and
    needs the other three; the plan runs only for a pull request into test, main or uat; shards need the plan, do not
    cancel each other and keep the package token to their Restore step;
  * the verdict is RUN, as bash, over every combination of job results: it is green only for a green lane (dev), or a
    green lane, a green plan with at least one shard and green shards (test, main, uat); anything else is red, by name;
  * the plan is RUN: an empty command, an empty array, bad JSON, duplicate labels, a bad entry or a failing command is a
    red plan, never an empty gate;
  * a shard's test step is RUN with a fake `dotnet`: a filter that selects no test fails the shard;
  * the lane runs everything (no selector, no docs-only skip, no code-style step) off the dev gate;
  * the GATE expression, which three places repeat, is the same text everywhere and maps the branches as documented.

    python3 governance/tests/pr-gate-v3.test.py

PR_GATE_V3_WORKFLOW overrides the workflow path (the mutation runner uses it). Needs PyYAML and bash.
"""
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-pr-v3.yml')
WORKFLOW = os.environ.get('PR_GATE_V3_WORKFLOW', DEFAULT)

VERDICT = 'Verdict (the lane, and on a test, main or uat pull request the plan and every shard)'
PLAN = 'Shard matrix'
TEST = 'Test (${{ matrix.shard.label }})'


def load():
    with open(WORKFLOW, encoding='utf-8') as handle:
        return yaml.safe_load(handle)


def bash(script, env, cwd, timeout=60):
    full = {'PATH': env.pop('PATH', os.environ.get('PATH', '/usr/bin:/bin')), 'HOME': cwd}
    full.update(env)
    return subprocess.run(['bash', '-c', script], env=full, cwd=cwd, capture_output=True, text=True, timeout=timeout)


class Shape(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.jobs = cls.doc['jobs']
        cls.on = cls.doc.get('on', cls.doc.get(True))

    def step(self, job, name):
        found = [s for s in self.jobs[job]['steps'] if s.get('name') == name]
        self.assertEqual(len(found), 1, f'{job}: step {name!r} found {len(found)} times')
        return found[0]

    def test_the_jobs_are_lane_plan_shard_and_the_verdict(self):
        self.assertEqual(list(self.jobs), ['lane', 'plan', 'shard', 'ci'])

    def test_the_verdict_is_named_ci_runs_always_and_needs_every_other_job(self):
        ci = self.jobs['ci']
        self.assertEqual(ci['name'], 'ci')
        self.assertEqual(ci['if'], '${{ always() }}')   # a skipped required check counts as passed
        self.assertEqual(sorted(ci['needs']), ['lane', 'plan', 'shard'])

    def test_no_other_job_is_named_ci(self):
        self.assertEqual([k for k, v in self.jobs.items() if v.get('name') == 'ci'], ['ci'])

    def test_the_plan_runs_only_for_a_pull_request_into_test_main_or_uat(self):
        condition = self.jobs['plan']['if']
        for needle in ("github.event_name == 'pull_request'", "github.base_ref == 'test'", "github.base_ref == 'main'", "github.base_ref == 'uat'"):
            self.assertIn(needle, condition)
        self.assertNotIn("'dev'", condition)

    def test_the_shards_need_a_green_plan_and_never_cancel_each_other(self):
        shard = self.jobs['shard']
        self.assertEqual(shard['needs'], 'plan')
        self.assertEqual(shard['if'], "${{ needs.plan.result == 'success' }}")
        self.assertIs(shard['strategy']['fail-fast'], False)
        self.assertEqual(shard['strategy']['matrix'], {'shard': '${{ fromJSON(needs.plan.outputs.matrix) }}'})

    def test_the_package_token_reaches_a_restore_step_only(self):
        for job in ('lane', 'shard'):
            holders = [s.get('name') for s in self.jobs[job]['steps'] if 'GH_PACKAGES_TOKEN' in str(s.get('env', {}))]
            self.assertEqual(holders, ['Restore'], job)
        for job in ('plan', 'ci'):
            self.assertNotIn('GH_PACKAGES_TOKEN', json.dumps(self.jobs[job]))

    def test_every_job_has_read_only_contents(self):
        for name, job in self.jobs.items():
            self.assertEqual(job['permissions'], {'contents': 'read'}, name)

    def test_the_gate_expression_is_one_text_in_the_lane_and_the_verdict(self):
        lane = self.jobs['lane']['env']['GATE']
        verdict = self.step('ci', VERDICT)['env']['GATE']
        self.assertEqual(lane, verdict)

    def test_the_new_inputs_are_optional_and_default_to_nothing_that_runs(self):
        inputs = self.on['workflow_call']['inputs']
        for name in ('shards-test', 'shards-uat'):
            self.assertEqual((inputs[name]['type'], inputs[name]['required'], inputs[name]['default']), ('string', False, ''))

    def test_off_the_dev_gate_the_lane_skips_neither_tests_nor_style_by_selection(self):
        lane = self.jobs['lane']['steps']
        by = {s['name']: s for s in lane}
        self.assertIn("env.GATE == 'dev'", by['Docs-only change']['env']['IGNORE_REGEX'])
        self.assertIn("env.GATE == 'dev'", by['Code style (changed files)']['if'])
        self.assertIn('"$GATE" != dev', by['Select tests']['run'])


def gate_of(expression, event, base):
    """Evaluate the GATE expression (only ==, &&, ||, string literals and two github.* names) the way Actions does."""
    py = expression.strip()
    py = re.sub(r"^\$\{\{\s*|\s*\}\}$", '', py)
    py = py.replace('&&', ' and ').replace('||', ' or ').replace('github.event_name', 'event').replace('github.base_ref', 'base')
    return eval(py, {'__builtins__': {}}, {'event': event, 'base': base})


class GateExpression(unittest.TestCase):
    def test_the_branches_map_as_documented(self):
        expression = load()['jobs']['lane']['env']['GATE']
        table = [('pull_request', 'dev', 'dev'), ('pull_request', 'test', 'test'), ('pull_request', 'main', 'test'),
                 ('pull_request', 'uat', 'uat'), ('pull_request', 'feature-x', 'dev'), ('pull_request', '', 'dev'),
                 ('workflow_dispatch', '', 'dev'), ('push', 'uat', 'dev')]
        for event, base, want in table:
            with self.subTest(event=event, base=base):
                self.assertEqual(gate_of(expression, event, base), want)


class Scratch(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='pr-gate-v3-'))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.temp = os.path.join(self.root, 'runner-temp')
        self.work = os.path.join(self.root, 'work')
        os.makedirs(self.temp)
        os.makedirs(self.work)
        self.jobs = load()['jobs']

    def script(self, job, name):
        return [s for s in self.jobs[job]['steps'] if s.get('name') == name][0]['run']

    def run_step(self, job, name, timeout=60, **env):
        return bash(self.script(job, name), {'RUNNER_TEMP': self.temp, 'GITHUB_OUTPUT': os.path.join(self.temp, 'out'), **env}, self.work, timeout=timeout)

    def outputs(self):
        path = os.path.join(self.temp, 'out')
        return dict(line.split('=', 1) for line in open(path).read().splitlines()) if os.path.exists(path) else {}


class Verdict(Scratch):
    def verdict(self, gate, lane, plan, shard, count=''):
        return self.run_step('ci', VERDICT, GATE=gate, LANE=lane, PLAN=plan, SHARD=shard, COUNT=count)

    def green(self, *args, **kw):
        done = self.verdict(*args, **kw)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def red(self, *args, said=None, **kw):
        done = self.verdict(*args, **kw)
        self.assertNotEqual(done.returncode, 0, 'the verdict passed: ' + done.stdout)
        if said:
            self.assertIn(said, done.stdout)

    def test_dev_is_the_lane_alone(self):
        self.green('dev', 'success', 'skipped', 'skipped')

    def test_dev_with_a_red_or_missing_lane_is_red(self):
        for lane in ('failure', 'cancelled', 'skipped', ''):
            with self.subTest(lane=lane):
                self.red('dev', lane, 'skipped', 'skipped', said='the lane did not succeed')

    def test_dev_that_ran_a_plan_or_shards_is_red(self):
        self.red('dev', 'success', 'success', 'skipped', said='the dev gate ran a plan or shards')
        self.red('dev', 'success', 'skipped', 'success', said='the dev gate ran a plan or shards')

    def test_test_main_and_uat_need_lane_plan_count_and_shards_all_green(self):
        for gate in ('test', 'uat'):
            with self.subTest(gate=gate):
                self.green(gate, 'success', 'success', 'success', count='24')

    def test_a_missing_or_red_piece_is_red_by_name(self):
        for gate in ('test', 'uat'):
            with self.subTest(gate=gate):
                self.red(gate, 'failure', 'success', 'success', count='3', said='the lane did not succeed')
                self.red(gate, 'success', 'failure', 'skipped', count='3', said='owes a shard plan')
                self.red(gate, 'success', 'skipped', 'skipped', count='', said='owes a shard plan')
                self.red(gate, 'success', 'success', 'failure', count='3', said='not every test shard succeeded')
                self.red(gate, 'success', 'success', 'cancelled', count='3', said='not every test shard succeeded')
                self.red(gate, 'success', 'success', 'skipped', count='3', said='not every test shard succeeded')

    def test_a_plan_with_no_shards_is_red_even_when_everything_else_is_green(self):
        for count in ('', '0', 'x', '-1'):
            with self.subTest(count=count):
                self.red('test', 'success', 'success', 'success', count=count, said='has no shards')

    def test_a_red_lane_is_red_whatever_the_shards_say(self):
        self.red('test', 'failure', 'success', 'success', count='5')


class Plan(Scratch):
    def plan(self, command, base='test', other=''):
        env = {'BASE': base, 'COMMAND_TEST': command if base != 'uat' else other, 'COMMAND_UAT': command if base == 'uat' else other}
        return self.run_step('plan', PLAN, **env)

    def test_a_valid_matrix_is_published_with_its_count(self):
        shards = [{'label': 'A', 'project': 'p.csproj', 'filter': 'FullyQualifiedName~X.'}, {'label': 'B', 'project': 'p.csproj', 'filter': ''}]
        done = self.plan(f"printf '%s' '{json.dumps(shards)}'")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        out = self.outputs()
        self.assertEqual(json.loads(out['matrix']), shards)
        self.assertEqual(out['count'], '2')

    def test_a_uat_pull_request_reads_the_uat_command_not_the_test_one(self):
        good = json.dumps([{'label': 'U', 'project': 'p.csproj', 'filter': ''}])
        done = self.plan(f"printf '%s' '{good}'", base='uat', other="printf '%s' '[]'")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.outputs()['count'], '1')

    def assert_red(self, command, said, base='test'):
        done = self.plan(command, base=base)
        self.assertNotEqual(done.returncode, 0, 'the plan passed: ' + done.stdout)
        self.assertIn(said, done.stdout + done.stderr)
        self.assertNotIn('matrix', self.outputs(), 'a red plan must publish no matrix')

    def test_no_command_is_red(self):
        self.assert_red('', 'owes test shards')
        self.assert_red('', 'owes test shards', base='uat')

    def test_an_empty_array_is_red(self):
        self.assert_red("echo '[]'", 'the plan is empty')

    def test_unreadable_json_is_red(self):
        self.assert_red("echo 'not json'", '')

    def test_a_bad_entry_is_red(self):
        self.assert_red('echo \'[{"label":"A","project":"p"}]\'', 'bad shard')
        self.assert_red('echo \'[{"label":"","project":"p","filter":""}]\'', 'bad shard')
        self.assert_red('echo \'[{"label":"A","project":"p","filter":1}]\'', 'bad shard')

    def test_duplicate_labels_are_red(self):
        entry = '{"label":"A","project":"p","filter":""}'
        self.assert_red(f"echo '[{entry},{entry}]'", 'duplicate shard labels')

    def test_a_failing_command_is_red_even_if_it_printed_a_matrix(self):
        self.assert_red('echo \'[{"label":"A","project":"p","filter":""}]\'; exit 3', '')


class ShardTest(Scratch):
    def fake_dotnet(self, total):
        bindir = os.path.join(self.root, 'bin')
        os.makedirs(bindir)
        path = os.path.join(bindir, 'dotnet')
        with open(path, 'w') as handle:
            handle.write(f'''#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do case "$1" in --results-directory) out="$2"; shift;; esac; shift; done
mkdir -p "$out"; printf '<TestRun><ResultSummary><Counters total="{total}" executed="{total}"/></ResultSummary></TestRun>' > "$out/Shard_1.trx"
''')
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
        return bindir

    def run_test(self, total, label='Shard 1', filter_text='FullyQualifiedName~X.'):
        bindir = self.fake_dotnet(total)
        return self.run_step('shard', TEST, PATH=bindir + ':' + os.environ.get('PATH', '/usr/bin:/bin'), LABEL=label,
                             PROJECT='p.csproj', FILTER=filter_text, HANG='20m')

    def test_a_shard_that_ran_tests_passes(self):
        done = self.run_test(12)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('ran 12 test(s)', done.stdout)

    def test_a_filter_that_selects_nothing_fails_the_shard(self):
        done = self.run_test(0)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('selected no tests', done.stdout)

    def test_the_label_becomes_a_safe_file_name(self):
        done = self.run_test(3, label='E2E / 1 (a b)')
        self.assertEqual(done.returncode, 1, 'the fake writes Shard_1.trx, so a different safe name finds no TRX and fails')


if __name__ == '__main__':
    unittest.main()
