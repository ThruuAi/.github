#!/usr/bin/env python3
"""Tests for the two speed switches of .github/workflows/dotnet-pr-v2.yml (ThruuAi/.github#9).

  * `global-json-sdk`            install the SDK global.json names, on its own, under $RUNNER_TEMP/dotnet, and fail
                                  the job unless `dotnet --version` is that version;
  * `static-checks-background`   start the caller's static checks in the background, join them in a step placed
                                  before the restore; the job fails when they fail, never start or die;

What is pinned (a caller that sets neither must see NO change, and a caller that sets them must lose no check):

  * each input is boolean, optional and OFF by default;
  * the new steps exist, in the agreed place, with the agreed conditions (the SDK install only when the switch is on
    and the build is incremental and not skipped; the join runs on every ready pull request, after a failure too, and
    before `Restore`);
  * the SDK install uses the pinned setup-dotnet commit, reads global.json, installs under `$RUNNER_TEMP/dotnet`;
  * the steps are RUN, as bash, in a scratch directory with a fake `dotnet`: the background checks pass, fail, never
    start or die and the join says so; the SDK step refuses a version that is not global.json's.

    python3 governance/tests/pr-lane-v2-speed.test.py

PR_LANE_V2_WORKFLOW overrides the workflow path (the mutation runner uses it). Needs PyYAML and bash.
"""
import os
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-pr-v2.yml')
WORKFLOW = os.environ.get('PR_LANE_V2_WORKFLOW', DEFAULT)

SETUP_DOTNET = 'actions/setup-dotnet@67a3573c9a986a3f9c594539f4ab511d57bb3ce9'
STATIC = 'Static checks'
JOIN = 'Static checks (result)'
PIN = 'Pinned .NET SDK (the version global.json names, same install path on every runner)'
SDK = '.NET SDK from the image (must satisfy global.json)'
BUILD = 'Build (Release)'
NORMALISE = 'Normalise file times against the cached tree'
RESTORE = 'Restore'
SWITCHES = ('global-json-sdk', 'static-checks-background')


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

    def test_every_switch_is_boolean_optional_and_off_by_default(self):
        for name in SWITCHES:
            with self.subTest(switch=name):
                item = self.inputs[name]
                self.assertEqual((item['type'], item['required'], item['default']), ('boolean', False, False))

    def test_the_pinned_sdk_step_installs_what_global_json_names_into_a_job_private_folder(self):
        step = self.step(PIN)
        self.assertEqual(step['uses'], SETUP_DOTNET)
        self.assertEqual(step['with'], {'global-json-file': 'global.json'})
        self.assertEqual(step['env'], {'DOTNET_INSTALL_DIR': '${{ runner.temp }}/dotnet'})
        self.assertEqual(step['if'], "steps.scope.outputs.skip != 'true' && inputs.incremental && inputs.global-json-sdk")

    def test_the_pinned_sdk_step_comes_before_the_static_checks_start_and_just_before_the_sdk_check(self):
        # Before the background checks start: the download then has the runner to itself (24 s beside them, 12 s alone).
        self.assertEqual(self.names.index(PIN), self.names.index(SDK) - 1)
        self.assertEqual(self.names.index('Docs-only change') + 1, self.names.index(PIN))
        self.assertLess(self.names.index(SDK), self.names.index(STATIC))

    def test_the_sdk_check_step_keeps_its_name_id_and_condition(self):
        step = self.step(SDK)
        self.assertEqual(step['id'], 'sdk')
        self.assertEqual(step['if'], "steps.scope.outputs.skip != 'true' && inputs.incremental")
        self.assertEqual(step['env'], {'PINNED': '${{ inputs.global-json-sdk }}'})

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
        self.assertGreater(self.names.index(STATIC), self.names.index(SDK))

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


FAKE_DOTNET = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOTNET_LOG"
if [ "$1" = "--version" ]; then echo "${FAKE_DOTNET_VERSION:-10.0.101}"; fi
exit 0
"""


class TheSdkStep(Scratch):
    def setUp(self):
        super().setUp()
        self.bin = os.path.join(self.root, 'bin')
        os.makedirs(self.bin)
        path = os.path.join(self.bin, 'dotnet')
        with open(path, 'w') as handle:
            handle.write(FAKE_DOTNET)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        self.log = os.path.join(self.root, 'dotnet.log')
        self.output = os.path.join(self.root, 'github_output')
        open(self.output, 'w').close()

    def run_sdk(self, pinned, resolved, wanted='10.0.101'):
        with open(os.path.join(self.work, 'global.json'), 'w') as handle:
            handle.write('{"sdk": {"version": "%s", "rollForward": "latestPatch"}}' % wanted)
        return self.run_step(SDK, PINNED=pinned, PATH=self.bin + ':' + os.environ.get('PATH', ''),
                             FAKE_DOTNET_LOG=self.log, FAKE_DOTNET_VERSION=resolved, GITHUB_OUTPUT=self.output)

    def test_not_pinned_any_version_the_host_resolves_is_accepted_and_recorded(self):
        done = self.run_sdk('false', '10.0.115')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('version=10.0.115', slurp(self.output))

    def test_pinned_the_exact_version_passes(self):
        done = self.run_sdk('true', '10.0.101')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('version=10.0.101', slurp(self.output))

    def test_pinned_another_patch_of_the_image_fails_closed(self):
        for resolved in ('10.0.114', '10.0.115', '10.0.1010', '10.0.10'):
            with self.subTest(resolved=resolved):
                done = self.run_sdk('true', resolved)
                self.assertNotEqual(done.returncode, 0)
                self.assertIn('global.json names 10.0.101', done.stderr)

    def test_pinned_without_a_global_json_version_fails(self):
        with open(os.path.join(self.work, 'global.json'), 'w') as handle:
            handle.write('{}')
        done = self.run_step(SDK, PINNED='true', PATH=self.bin + ':' + os.environ.get('PATH', ''),
                             FAKE_DOTNET_LOG=self.log, FAKE_DOTNET_VERSION='10.0.101', GITHUB_OUTPUT=self.output)
        self.assertNotEqual(done.returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=1)
