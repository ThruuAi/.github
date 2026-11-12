#!/usr/bin/env python3
"""Tests for the `job-private-nuget` input of .github/workflows/dotnet-pr-v2.yml (ThruuAi/.github#7).

dotnet-pr-v2.yml is the reusable pull-request lane that product repositories pin by commit SHA. Its compiled-output
cache (obj/) is reusable only when the NuGet packages folder has the same absolute path as in the job that built it,
so the lane must be able to restore NuGet into the folder the caller's producer builds against, which is
`$RUNNER_TEMP/nuget-packages` (job-private; the callers' hermetic-restore rule). These tests pin:

  * the input exists, is boolean and is OFF by default; every other input keeps its type, requiredness and default
    (a caller that does not set it must see no change);
  * the two new steps are the FIRST steps of the job, before checkout, the static checks or any .NET step, and run
    only when the input is true; the export lines are exactly the agreed two;
  * the two steps are RUN, as bash, on a scratch RUNNER_TEMP: the export lands in the right place and the check
    refuses every folder outside it (behaviour, not text);
  * the NuGet cache path is `$RUNNER_TEMP/nuget-packages` when the input is true (the same folder the export
    writes) and the literal `~/.nuget/packages` otherwise; its key and restore-keys are untouched, so it still
    finds the caches the producer saves;
  * nothing else sets the NuGet locations, and the ordered list of steps is the agreed one (a check cannot be
    dropped without this test being edited on purpose).

    python3 governance/tests/pr-lane-v2-workflow.test.py

PR_LANE_V2_WORKFLOW overrides the workflow path (the mutation runner uses it). Needs PyYAML.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-pr-v2.yml')
WORKFLOW = os.environ.get('PR_LANE_V2_WORKFLOW', DEFAULT)

VARIABLES = {'NUGET_PACKAGES': 'nuget-packages', 'NUGET_HTTP_CACHE_PATH': 'nuget-http-cache'}
EXPORT_LINE = "printf '{name}=%s/{folder}\\n' \"$RUNNER_TEMP\" >> \"$GITHUB_ENV\""
CACHE_PATH = "${{ inputs.job-private-nuget && format('{0}/nuget-packages', runner.temp) || '~/.nuget/packages' }}"
CACHE_KEY = "nuget-${{ runner.os }}-${{ hashFiles(inputs.cache-dependency-path) }}"
CACHE_RESTORE_KEYS = "nuget-${{ runner.os }}-"

# (type, required, default) of every input that existed before `job-private-nuget`.
EXISTING_INPUTS = {
    'solution': ('string', True, None),
    'unit-projects': ('string', True, None),
    'integration-projects': ('string', False, ''),
    'integration-filter': ('string', False, ''),
    'msbuild-args': ('string', False, ''),
    'docs-only-regex': ('string', False, ''),
    'static-checks': ('string', False, ''),
    'format-verify': ('boolean', False, True),
    'incremental': ('boolean', False, False),
    'selector': ('string', False, ''),
    'cache-dependency-path': ('string', False, '**/packages.lock.json\n**/Directory.*.props\n**/*.csproj\nglobal.json\n'),
    'timeout-minutes': ('number', False, 15),
    'runner': ('string', False, 'ubuntu-24.04'),
}

STEP_NAMES = [
    'Use job-owned NuGet locations',
    'Fail unless the NuGet locations are job-owned',
    'Checkout (the pull request merged into its base)',
    'Docs-only change',
    'Static checks',
    'Select tests',
    '.NET SDK from the image (must satisfy global.json)',
    'Setup .NET (SDK from global.json, NuGet cache)',
    'NuGet packages (restore from the dev cache)',
    'Compiled output (restore obj/ from dev)',
    'Normalise file times against the cached tree',
    'Restore',
    'Build (Release)',
    'Code style (changed files)',
    'Tests (unit, then RLS slice)',
    'Integration tests (filtered)',
    'Upload test results (failure only)',
]


def load():
    with open(WORKFLOW, encoding='utf-8') as handle:
        return yaml.safe_load(handle)


def bash(script, env):
    full = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': env.pop('HOME', '/nonexistent')}
    full.update(env)
    return subprocess.run(['bash', '-c', script], env=full, capture_output=True, text=True)


def evaluate_cache_path(expression, enabled, runner_temp):
    """Evaluate the one expression shape this workflow uses: `<input> && format('{0}/x', runner.temp) || '<literal>'`."""
    match = re.fullmatch(
        r"\$\{\{ inputs\.job-private-nuget && format\('\{0\}/([^']+)', runner\.temp\) \|\| '([^']+)' \}\}", expression)
    if match is None:
        raise AssertionError(f'the NuGet cache path is not the agreed expression: {expression!r}')
    return f'{runner_temp}/{match.group(1)}' if enabled else match.group(2)


class Contract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.on = cls.doc.get('on', cls.doc.get(True))
        cls.inputs = cls.on['workflow_call']['inputs']
        cls.job = cls.doc['jobs']['ci']
        cls.steps = cls.job['steps']

    def named(self, name):
        found = [s for s in self.steps if s.get('name') == name]
        self.assertEqual(len(found), 1, f'step {name!r} found {len(found)} times')
        return found[0]

    def test_the_input_is_boolean_optional_and_off_by_default(self):
        item = self.inputs['job-private-nuget']
        self.assertEqual((item['type'], item['required'], item['default']), ('boolean', False, False))

    def test_every_existing_input_keeps_its_type_requiredness_and_default(self):
        self.assertEqual(set(self.inputs), set(EXISTING_INPUTS) | {'job-private-nuget'})
        for name, (kind, required, default) in EXISTING_INPUTS.items():
            with self.subTest(input=name):
                item = self.inputs[name]
                self.assertEqual(item['type'], kind)
                self.assertEqual(item.get('required', False), required)
                self.assertEqual(item.get('default'), default)

    def test_the_secret_is_unchanged(self):
        secrets = self.on['workflow_call']['secrets']
        self.assertEqual(list(secrets), ['GH_PACKAGES_TOKEN'])
        self.assertTrue(secrets['GH_PACKAGES_TOKEN']['required'])

    def test_the_ordered_step_list_is_the_agreed_one(self):
        self.assertEqual([s.get('name') for s in self.steps], STEP_NAMES)

    def test_the_two_new_steps_are_first_and_only_run_when_the_input_is_true(self):
        for index, name in enumerate(STEP_NAMES[:2]):
            with self.subTest(step=name):
                self.assertEqual(self.steps[index]['name'], name)
                self.assertEqual(self.steps[index]['if'], 'inputs.job-private-nuget')
                self.assertNotIn('uses', self.steps[index])

    def test_the_first_two_steps_run_no_dotnet(self):
        for index, step in enumerate(self.steps[:2]):
            code = '\n'.join(l for l in str(step['run']).splitlines() if not l.lstrip().startswith('#'))
            self.assertIsNone(re.search(r'(?m)(?:^|[;&|(])[ \t]*dotnet[ \t]', code), f'step {index} runs dotnet')

    def test_the_export_lines_are_exactly_the_two_agreed_ones(self):
        run = str(self.steps[0]['run'])
        lines = [l.strip() for l in run.splitlines() if l.strip()]
        self.assertEqual(sorted(lines), sorted(EXPORT_LINE.format(name=n, folder=f) for n, f in VARIABLES.items()))

    def test_no_other_place_sets_the_nuget_locations(self):
        self.assertFalse(set(VARIABLES) & set((self.job.get('env') or {}).keys()))
        self.assertFalse(set(VARIABLES) & set((self.doc.get('env') or {}).keys()))
        for step in self.steps[2:]:
            with self.subTest(step=step.get('name')):
                self.assertFalse(set(VARIABLES) & set((step.get('env') or {}).keys()))
                self.assertNotIn('GITHUB_ENV', re.sub(r'#.*', '', str(step.get('run', ''))).replace('GITHUB_OUTPUT', ''),
                                 'a later step writes to GITHUB_ENV')

    def test_the_cache_path_follows_the_input_and_names_the_exported_folder(self):
        step = self.named('NuGet packages (restore from the dev cache)')
        expression = step['with']['path']
        self.assertEqual(expression, CACHE_PATH)
        temp = '/home/runner/work/_temp'
        self.assertEqual(evaluate_cache_path(expression, True, temp), f"{temp}/{VARIABLES['NUGET_PACKAGES']}")
        self.assertEqual(evaluate_cache_path(expression, False, temp), '~/.nuget/packages')

    def test_the_cache_key_and_restore_keys_are_untouched(self):
        step = self.named('NuGet packages (restore from the dev cache)')
        self.assertEqual(step['with']['key'], CACHE_KEY)
        self.assertEqual(step['with']['restore-keys'], CACHE_RESTORE_KEYS)
        self.assertEqual(step['if'], 'steps.scope.outputs.skip != \'true\' && inputs.incremental')

    def test_the_compiled_output_cache_is_untouched(self):
        step = self.named('Compiled output (restore obj/ from dev)')
        self.assertEqual(step['with']['path'], 'src/**/obj\n.ci-cache\n')
        self.assertEqual(step['with']['key'], 'obj-v1-${{ runner.os }}-${{ steps.sdk.outputs.version }}-${{ github.sha }}')
        self.assertEqual(step['with']['restore-keys'], 'obj-v1-${{ runner.os }}-${{ steps.sdk.outputs.version }}-')

    def test_the_package_token_still_reaches_the_restore_step_only(self):
        holders = [s.get('name') for s in self.steps if 'GH_PACKAGES_TOKEN' in str(s.get('env', {}))]
        self.assertEqual(holders, ['Restore'])
        self.assertNotIn('GH_PACKAGES_TOKEN', str(self.job.get('env', {})))


class TheStepsRun(unittest.TestCase):
    """Run the two steps as bash. The check must refuse everything the export would not write."""

    @classmethod
    def setUpClass(cls):
        steps = load()['jobs']['ci']['steps']
        cls.export, cls.check = str(steps[0]['run']), str(steps[1]['run'])

    def setUp(self):
        self.temp = tempfile.mkdtemp(prefix='pr-lane-temp-')
        self.good = {n: f'{self.temp}/{f}' for n, f in VARIABLES.items()}
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)

    def run_check(self, **override):
        env = {'RUNNER_TEMP': self.temp, **self.good}
        env.update(override)
        return bash(self.check, {k: v for k, v in env.items() if v is not None})

    def test_the_export_writes_the_folders_under_runner_temp_and_the_check_accepts_them(self):
        github_env = os.path.join(self.temp, 'github_env')
        open(github_env, 'w').close()
        done = bash(self.export, {'RUNNER_TEMP': self.temp, 'GITHUB_ENV': github_env})
        self.assertEqual(done.returncode, 0, done.stderr)
        with open(github_env, encoding='utf-8') as handle:
            written = dict(l.split('=', 1) for l in handle.read().splitlines())
        self.assertEqual(written, self.good)
        accepted = bash(self.check, {'RUNNER_TEMP': self.temp, **written})
        self.assertEqual(accepted.returncode, 0, accepted.stderr)

    def test_a_good_environment_passes(self):
        self.assertEqual(self.run_check().returncode, 0)

    def test_every_variable_is_checked_when_unset_outside_or_dotted(self):
        for name in VARIABLES:
            for label, value in (
                ('unset', None),
                ('empty', ''),
                ('outside', '/home/runner/.nuget/packages'),
                ('dotdot', f'{self.temp}/../x'),
                ('is runner temp itself', self.temp),
                ('a sibling with the same prefix', self.temp + '-other/x'),
            ):
                with self.subTest(variable=name, case=label):
                    result = self.run_check(**{name: value})
                    self.assertNotEqual(result.returncode, 0, f'{name} {label} was accepted')
                    if value is not None:
                        self.assertIn('FAIL', result.stderr)

    def test_an_empty_runner_temp_cannot_make_every_absolute_path_pass(self):
        paths = {'NUGET_PACKAGES': '/x/p', 'NUGET_HTTP_CACHE_PATH': '/x/c'}
        self.assertNotEqual(bash(self.check, {'RUNNER_TEMP': '', **paths}).returncode, 0)
        self.assertNotEqual(bash(self.check, dict(paths)).returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=1)
