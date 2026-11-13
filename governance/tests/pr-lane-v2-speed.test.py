#!/usr/bin/env python3
"""Tests for the `static-checks-background` input of .github/workflows/dotnet-pr-v2.yml (ThruuAi/.github#9).

The caller's `static-checks` script starts in the background and is joined in a step placed before the restore; the
job fails when the checks fail, never start or die. What is pinned (a caller that does not set the input must see no
change, and a caller that sets it must lose no check):

  * the input is boolean, optional and OFF by default;
  * the join step exists, in the agreed place (after the cache restores and the time normalisation, just before
    `Restore`, so a failed check still stops the job before the expensive steps) with the agreed condition (every ready
    pull request, docs-only ones included, and after a failure too);
  * the package token still reaches the restore step only;
  * the steps are RUN, as bash, in a scratch directory: the background checks pass, fail, never start or die and the
    join says so; off, the checks run to completion as before.

    python3 governance/tests/pr-lane-v2-speed.test.py

PR_LANE_V2_WORKFLOW overrides the workflow path (the mutation runner uses it). Needs PyYAML and bash.
"""
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-pr-v2.yml')
WORKFLOW = os.environ.get('PR_LANE_V2_WORKFLOW', DEFAULT)

STATIC = 'Static checks'
JOIN = 'Static checks (result)'
BUILD = 'Build (Release)'
NORMALISE = 'Normalise file times against the cached tree'
RESTORE = 'Restore'


def slurp(path):
    with open(path, encoding='utf-8') as handle:
        return handle.read()


def load():
    with open(WORKFLOW, encoding='utf-8') as handle:
        return yaml.safe_load(handle)


class Contract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.on = cls.doc.get('on', cls.doc.get(True))
        cls.inputs = cls.on['workflow_call']['inputs']
        cls.steps = cls.doc['jobs']['ci']['steps']
        cls.names = [s.get('name') for s in cls.steps]

    def step(self, name):
        found = [s for s in self.steps if s.get('name') == name]
        self.assertEqual(len(found), 1, f'step {name!r} found {len(found)} times')
        return found[0]

    def test_the_switch_is_boolean_optional_and_off_by_default(self):
        item = self.inputs['static-checks-background']
        self.assertEqual((item['type'], item['required'], item['default']), ('boolean', False, False))

    def test_the_join_runs_on_every_ready_pull_request_even_after_a_failure_and_before_the_restore(self):
        step = self.step(JOIN)
        self.assertEqual(step['if'], "${{ !cancelled() && inputs.static-checks != '' && inputs.static-checks-background }}")
        self.assertEqual(self.names.index(JOIN), self.names.index(RESTORE) - 1)
        self.assertEqual(self.names.index(JOIN), self.names.index(NORMALISE) + 1)
        self.assertNotIn('steps.scope', step['if'])   # docs-only runs must still join

    def test_the_static_step_is_one_step_with_the_agreed_env_and_still_before_the_selector(self):
        step = self.step(STATIC)
        self.assertEqual(step['if'], "inputs.static-checks != ''")
        self.assertEqual(step['env'], {'CHECKS': '${{ inputs.static-checks }}',
                                       'BACKGROUND': '${{ inputs.static-checks-background }}'})
        self.assertLess(self.names.index(STATIC), self.names.index('Select tests'))

    def test_the_join_is_before_every_step_that_sees_the_package_token_or_builds(self):
        for later in (RESTORE, BUILD, 'Tests (unit, then RLS slice)'):
            self.assertLess(self.names.index(JOIN), self.names.index(later))

    def test_the_package_token_still_reaches_the_restore_step_only(self):
        holders = [s.get('name') for s in self.steps if 'GH_PACKAGES_TOKEN' in str(s.get('env', {}))]
        self.assertEqual(holders, [RESTORE])


def bash(script, env, cwd, timeout=60):
    full = {'PATH': env.pop('PATH', os.environ.get('PATH', '/usr/bin:/bin')), 'HOME': cwd}
    full.update(env)
    return subprocess.run(['bash', '-c', script], env=full, cwd=cwd, capture_output=True, text=True, timeout=timeout)


class Scratch(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='pr-lane-speed-'))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.temp = os.path.join(self.root, 'runner-temp')
        self.work = os.path.join(self.root, 'work')
        os.makedirs(self.temp)
        os.makedirs(self.work)
        steps = load()['jobs']['ci']['steps']
        self.scripts = {s['name']: s['run'] for s in steps if 'run' in s}

    def run_step(self, name, timeout=60, **env):
        env = {'RUNNER_TEMP': self.temp, **env}
        return bash(self.scripts[name], env, self.work, timeout=timeout)


class StaticChecksInTheBackground(Scratch):
    def start(self, checks, background='true'):
        return self.run_step(STATIC, CHECKS=checks, BACKGROUND=background)

    def join(self):
        return self.run_step(JOIN, timeout=20)   # a join that waits for ever is a failure, not a hang

    def test_off_it_runs_the_checks_to_completion_and_a_failure_fails_the_step(self):
        ok = self.start('echo hello-from-checks', background='false')
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn('hello-from-checks', ok.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.temp, 'static-checks-bg')), 'off must not start anything')
        bad = self.start('echo before; false; echo never', background='false')
        self.assertNotEqual(bad.returncode, 0)

    def test_on_the_step_returns_at_once_and_the_join_reports_a_pass_with_the_log(self):
        began = time.time()
        started = self.start('sleep 2; echo "::group::static check x: ok"; echo the-log-line; echo "::endgroup::"')
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertLess(time.time() - began, 1.5, 'the step waited for the checks')
        joined = self.join()
        self.assertEqual(joined.returncode, 0, joined.stdout + joined.stderr)
        self.assertIn('the-log-line', joined.stdout)
        self.assertIn('::group::static check x: ok', joined.stdout)

    def test_a_failing_script_fails_the_join_and_its_output_is_shown(self):
        self.assertEqual(self.start('echo visible-failure-text; exit 3').returncode, 0)
        joined = self.join()
        self.assertNotEqual(joined.returncode, 0)
        self.assertIn('visible-failure-text', joined.stdout)
        self.assertIn('exit status 3', joined.stdout)

    def test_an_early_failure_in_the_script_stops_it_like_the_foreground_run_does(self):
        # bash -e: the first failing command ends the script, so the later echo must not appear.
        self.assertEqual(self.start('false\necho must-not-run').returncode, 0)
        joined = self.join()
        self.assertNotEqual(joined.returncode, 0)
        self.assertNotIn('must-not-run', joined.stdout)

    def test_a_pipefail_failure_counts(self):
        self.assertEqual(self.start('false | cat').returncode, 0)
        self.assertNotEqual(self.join().returncode, 0)

    def test_a_join_without_a_start_fails(self):
        joined = self.join()
        self.assertNotEqual(joined.returncode, 0)
        self.assertIn('never started', joined.stderr)

    def test_a_checks_process_that_dies_without_a_result_fails_the_join(self):
        self.assertEqual(self.start('sleep 30').returncode, 0)
        pid_file = os.path.join(self.temp, 'static-checks-bg', 'pid')
        for _ in range(50):
            if os.path.exists(pid_file) and os.path.getsize(pid_file) > 0:
                break
            time.sleep(0.1)
        pid = int(slurp(pid_file))
        time.sleep(0.5)   # let the wrapper start its child, so the child can be cleaned up after the wrapper is killed

        def children(parent):
            done = subprocess.run(['pgrep', '-P', str(parent)], capture_output=True, text=True)
            return [int(p) for p in done.stdout.split()]
        orphans = [c for kid in children(pid) for c in [kid] + children(kid)]
        os.kill(pid, signal.SIGKILL)          # the wrapper is gone before it can write a result
        for orphan in orphans:
            try:
                os.kill(orphan, signal.SIGKILL)
            except ProcessLookupError:
                pass
        joined = self.join()
        self.assertNotEqual(joined.returncode, 0)
        self.assertIn('gone without a result', joined.stderr)

    def test_the_checks_see_the_working_directory_and_the_runner_temp(self):
        os.makedirs(os.path.join(self.work, 'marker-dir'))
        self.assertEqual(self.start('test -d marker-dir && test -n "$RUNNER_TEMP"').returncode, 0)
        self.assertEqual(self.join().returncode, 0)

    def test_a_script_that_exports_a_path_does_not_leak_it_into_the_join(self):
        self.assertEqual(self.start('export PATH=/nonexistent; true').returncode, 0)
        self.assertEqual(self.join().returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=1)
