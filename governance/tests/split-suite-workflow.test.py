#!/usr/bin/env python3
"""Tests for .github/workflows/dotnet-split-suite.yml (ThruuAi/.github#5).

The workflow is a reusable one that other repositories pin by commit SHA and run on persistent
self-hosted runners. These tests pin what makes that safe:

  * every job that runs .NET starts with the step that writes the four job-private locations to
    GITHUB_ENV, then the step that fails unless they are under $RUNNER_TEMP, before any checkout,
    setup-dotnet, cache or dotnet step. The jobs are found by what their steps do, not by name, so a
    new .NET job (or a .NET step added to `summary`) is held to the same rule;
  * the two steps are RUN, as bash, on a scratch RUNNER_TEMP: the export lands in the right place and
    the check refuses every folder outside it (the check is behaviour, not text);
  * checkout is clean; the setup-dotnet cache is off unless the runner is GitHub-hosted;
  * `runner-group` is optional, empty by default, and with it empty `runs-on` is exactly `inputs.runner`.

    python3 governance/tests/split-suite-workflow.test.py

SPLIT_SUITE_WORKFLOW overrides the workflow path (the mutation runner uses it). Needs PyYAML, which the
"YAML parses" step of governance-tests.yml already needs.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-split-suite.yml')
WORKFLOW = os.environ.get('SPLIT_SUITE_WORKFLOW', DEFAULT)

VARIABLES = {
    'DOTNET_INSTALL_DIR': 'dotnet',
    'DOTNET_CLI_HOME': 'dotnet-home',
    'NUGET_PACKAGES': 'nuget-packages',
    'NUGET_HTTP_CACHE_PATH': 'nuget-http-cache',
}
# The exact line the callers' own isolation checks look for in their own jobs.
EXPORT_LINE = "printf '{name}=%s/{folder}\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\""
# Today's value of `runs-on` for every job when `runner-group` is empty, and the shape when it is set.
RUNS_ON = (
    "${{ inputs.runner-group != '' && fromJSON(format('{{\"group\":{0},\"labels\":[{1}]}}', "
    "toJSON(inputs.runner-group), toJSON(inputs.runner))) || inputs.runner }}"
)
DOTNET_JOBS = {'build', 'shard'}


def load():
    with open(WORKFLOW, encoding='utf-8') as handle:
        return yaml.safe_load(handle)


def steps_of(job):
    return job.get('steps', [])


def touches_dotnet(step):
    """A step that runs `dotnet`, the setup-dotnet action or a cache action (comments do not count)."""
    uses = str(step.get('uses', ''))
    if 'setup-dotnet' in uses or 'actions/cache' in uses:
        return True
    code = '\n'.join(l for l in str(step.get('run', '')).splitlines() if not l.lstrip().startswith('#'))
    # `dotnet` as a command: first word of a line or after ; & | ( . A path such as $RUNNER_TEMP/dotnet is not one.
    return re.search(r'(?m)(?:^|[;&|(])[ \t]*dotnet[ \t]', code) is not None


def is_checkout(step):
    return 'actions/checkout' in str(step.get('uses', ''))


def export_index(job):
    wanted = [EXPORT_LINE.format(name=n, folder=f) for n, f in VARIABLES.items()]
    for i, step in enumerate(steps_of(job)):
        run = str(step.get('run', ''))
        if all(line in run for line in wanted):
            return i
    return None


def check_index(job):
    for i, step in enumerate(steps_of(job)):
        run = str(step.get('run', ''))
        if 'FAIL' in run and 'RUNNER_TEMP' in run and 'exit 1' in run and 'NUGET_PACKAGES' in run:
            return i
    return None


def bash(script, env):
    full = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': env.pop('HOME', '/nonexistent')}
    full.update(env)
    return subprocess.run(['bash', '-c', script], env=full, capture_output=True, text=True)


class JobPrivateState(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.jobs = cls.doc['jobs']
        cls.dotnet_jobs = {n: j for n, j in cls.jobs.items() if any(touches_dotnet(s) for s in steps_of(j))}

    def test_the_jobs_found_are_the_ones_that_run_dotnet(self):
        # Guards the detector itself: an empty or wrong set would make every other test vacuous.
        self.assertEqual(set(self.dotnet_jobs), DOTNET_JOBS)

    def test_every_dotnet_job_exports_the_four_variables_before_anything_else(self):
        for name, job in self.dotnet_jobs.items():
            with self.subTest(job=name):
                self.assertEqual(export_index(job), 0, f'{name}: the export step is not the first step')

    def test_every_dotnet_job_has_the_check_right_after_the_export(self):
        for name, job in self.dotnet_jobs.items():
            with self.subTest(job=name):
                self.assertEqual(check_index(job), 1, f'{name}: the check step is not the second step')

    def test_nothing_that_touches_dotnet_comes_before_the_check(self):
        for name, job in self.dotnet_jobs.items():
            with self.subTest(job=name):
                self.assertIsNotNone(check_index(job), f'{name}: no check step')
                first = min(i for i, s in enumerate(steps_of(job)) if touches_dotnet(s) or is_checkout(s))
                self.assertGreater(first, check_index(job))

    def test_the_exported_values_are_exactly_the_agreed_folders(self):
        for name, job in self.dotnet_jobs.items():
            self.assertIsNotNone(export_index(job), f'{name}: no export step')
            run = str(steps_of(job)[export_index(job)]['run'])
            lines = [l.strip() for l in run.splitlines() if l.strip()]
            with self.subTest(job=name):
                self.assertEqual(sorted(lines), sorted(EXPORT_LINE.format(name=n, folder=f) for n, f in VARIABLES.items()))

    def test_job_level_env_does_not_set_the_locations(self):
        # A job-level value would be a second source of truth for what the first step decides.
        for name, job in self.dotnet_jobs.items():
            with self.subTest(job=name):
                self.assertFalse(set(VARIABLES) & set((job.get('env') or {}).keys()))
        self.assertFalse(set(VARIABLES) & set((self.doc.get('env') or {}).keys()))

    def test_checkout_is_clean_and_keeps_no_credentials(self):
        seen = 0
        for name, job in self.dotnet_jobs.items():
            for step in steps_of(job):
                if is_checkout(step):
                    seen += 1
                    with self.subTest(job=name):
                        self.assertIs(step['with'].get('clean'), True)
                        self.assertIs(step['with'].get('persist-credentials'), False)
        self.assertEqual(seen, 2)

    def test_the_nuget_cache_is_on_only_for_a_github_hosted_runner(self):
        seen = 0
        for name, job in self.dotnet_jobs.items():
            for step in steps_of(job):
                if 'setup-dotnet' in str(step.get('uses', '')):
                    seen += 1
                    with self.subTest(job=name):
                        self.assertEqual(step['with']['cache'], "${{ runner.environment == 'github-hosted' }}")
        self.assertEqual(seen, 2)


class TheStepsRun(unittest.TestCase):
    """Run the two steps of EVERY .NET job as bash. The check must refuse everything the export would not write."""

    @classmethod
    def setUpClass(cls):
        jobs = load()['jobs']
        cls.scripts = {}
        for name in sorted(DOTNET_JOBS):
            job = jobs[name]
            assert export_index(job) is not None and check_index(job) is not None, f'{name}: steps missing'
            cls.scripts[name] = (str(steps_of(job)[export_index(job)]['run']), str(steps_of(job)[check_index(job)]['run']))

    def setUp(self):
        self.temp = tempfile.mkdtemp(prefix='ss-temp-')
        self.good = {n: f'{self.temp}/{f}' for n, f in VARIABLES.items()}
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)

    def run_check(self, script, **override):
        env = {'RUNNER_TEMP': self.temp, **self.good}
        env.update(override)
        return bash(script, {k: v for k, v in env.items() if v is not None})

    def test_the_export_writes_the_folders_under_runner_temp_and_the_check_accepts_them(self):
        for job, (export, check) in self.scripts.items():
            with self.subTest(job=job):
                github_env = os.path.join(self.temp, f'github_env_{job}')
                open(github_env, 'w').close()
                done = bash(export, {'RUNNER_TEMP': self.temp, 'GITHUB_ENV': github_env})
                self.assertEqual(done.returncode, 0, done.stderr)
                with open(github_env, encoding='utf-8') as handle:
                    written = dict(l.split('=', 1) for l in handle.read().splitlines())
                self.assertEqual(written, self.good)
                accepted = bash(check, {'RUNNER_TEMP': self.temp, **written})
                self.assertEqual(accepted.returncode, 0, accepted.stderr)

    def test_a_good_environment_passes(self):
        for job, (_, check) in self.scripts.items():
            with self.subTest(job=job):
                self.assertEqual(self.run_check(check).returncode, 0)

    def test_every_variable_is_checked_when_unset_outside_or_dotted(self):
        for job, (_, check) in self.scripts.items():
            for name in VARIABLES:
                for label, value in (
                    ('unset', None),
                    ('empty', ''),
                    ('outside', '/home/runner/.nuget/packages'),
                    ('dotdot', f'{self.temp}/../x'),
                    ('is runner temp itself', self.temp),
                    ('a sibling with the same prefix', self.temp + '-other/x'),
                ):
                    with self.subTest(job=job, variable=name, case=label):
                        result = self.run_check(check, **{name: value})
                        self.assertNotEqual(result.returncode, 0, f'{name} {label} was accepted')
                        if value is not None:
                            self.assertIn('FAIL', result.stderr)

    def test_an_empty_runner_temp_cannot_make_every_absolute_path_pass(self):
        paths = {'DOTNET_INSTALL_DIR': '/x/d', 'DOTNET_CLI_HOME': '/x/h', 'NUGET_PACKAGES': '/x/p', 'NUGET_HTTP_CACHE_PATH': '/x/c'}
        for job, (_, check) in self.scripts.items():
            with self.subTest(job=job, runner_temp='empty'):
                self.assertNotEqual(bash(check, {'RUNNER_TEMP': '', **paths}).returncode, 0)
            with self.subTest(job=job, runner_temp='unset'):
                self.assertNotEqual(bash(check, dict(paths)).returncode, 0)


class RunnerGroup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.on = cls.doc.get('on', cls.doc.get(True))
        cls.inputs = cls.on['workflow_call']['inputs']

    def test_runner_is_unchanged(self):
        runner = self.inputs['runner']
        self.assertEqual((runner['type'], runner['required'], runner['default']), ('string', False, 'ubuntu-24.04'))

    def test_runner_group_is_optional_and_empty_by_default(self):
        group = self.inputs['runner-group']
        self.assertEqual((group['type'], group['required'], group['default']), ('string', False, ''))

    def test_every_job_uses_the_one_expression(self):
        for name, job in self.doc['jobs'].items():
            with self.subTest(job=name):
                self.assertEqual(job['runs-on'], RUNS_ON)

    def test_with_the_group_empty_runs_on_is_exactly_the_runner_input(self):
        # The expression is `<group set> && <object> || inputs.runner`: with the group empty the left side
        # is false and the value is `inputs.runner`, the string every job used before this input existed.
        match = re.fullmatch(r"\$\{\{ inputs\.runner-group != '' && (.+) \|\| inputs\.runner \}\}", RUNS_ON)
        self.assertIsNotNone(match)
        self.assertTrue(all(job['runs-on'].endswith(" || inputs.runner }}") for job in self.doc['jobs'].values()))
        self.assertTrue(all(job['runs-on'].startswith("${{ inputs.runner-group != '' && ") for job in self.doc['jobs'].values()))

    def test_with_the_group_set_the_object_is_valid_json_for_awkward_values(self):
        template = re.search(r"format\('(.+?)', toJSON", RUNS_ON).group(1)
        for group, label in (('omni237-nightly', 'omni-light'), ('g"x', 'l\\y'), ('a b', "it's")):
            with self.subTest(group=group, label=label):
                # str.format and GitHub's format() both read `{{` and `}}` as literal braces.
                text = template.format(json.dumps(group), json.dumps(label))
                self.assertEqual(json.loads(text), {'group': group, 'labels': [label]})


if __name__ == '__main__':
    unittest.main(verbosity=1)
