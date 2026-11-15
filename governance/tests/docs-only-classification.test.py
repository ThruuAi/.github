#!/usr/bin/env python3
"""The "Docs-only change" step of dotnet-pr.yml and dotnet-pr-v2.yml must never call a pull request docs-only
unless every changed file is (ThruuAi/.github#11, omni237#5473).

The step is RUN, as bash, against a real git repository whose HEAD is a merge commit (the shape of a pull_request
checkout: HEAD^1 the base tip, HEAD^2 the pull request head). The failure it pins: a file list longer than the
64 KB pipe buffer made `printf | grep -q` die of a closed pipe, `pipefail` made the pipeline fail, and the step
reported skip=true for a promotion of 1,411 files, so `pr / ci` was green without a build or a test.

    python3 governance/tests/docs-only-classification.test.py

DOCS_ONLY_WORKFLOWS (path list, os.pathsep) overrides the workflow files (the mutation runner uses it). Needs PyYAML, git, bash.
"""
import os
import shutil
import subprocess
import tempfile
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '.github', 'workflows')
WORKFLOWS = os.environ.get('DOCS_ONLY_WORKFLOWS', os.pathsep.join(
    os.path.join(ROOT, name) for name in ('dotnet-pr.yml', 'dotnet-pr-v2.yml'))).split(os.pathsep)
REGEX = r'^(docs/|docs-new/|website/|test-plan/)|\.md$'
STEP = 'Docs-only change'


def script(path):
    with open(path, encoding='utf-8') as handle:
        doc = yaml.safe_load(handle)
    found = [s for s in doc['jobs']['ci']['steps'] if s.get('name') == STEP]
    assert len(found) == 1, f'{path}: step {STEP!r} found {len(found)} times'
    return found[0]['run']


def git(cwd, *args):
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': cwd, 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}
    subprocess.run(['git', *args], cwd=cwd, env=env, check=True, capture_output=True)


class Classification(unittest.TestCase):
    def merge_checkout(self, paths):
        """A repo whose HEAD merges a branch that adds `paths` into a base with one file."""
        root = os.path.realpath(tempfile.mkdtemp(prefix='docs-only-'))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        git(root, 'init', '-q', '-b', 'base')
        open(os.path.join(root, 'README.txt'), 'w').write('base\n')
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'base')
        git(root, 'checkout', '-q', '-b', 'pr')
        for p in paths:
            full = os.path.join(root, p)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            open(full, 'w').write('x\n')
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'pr')
        git(root, 'checkout', '-q', 'base')
        open(os.path.join(root, 'BASE-ONLY.txt'), 'w').write('b\n')   # the base moved: a real merge commit
        git(root, 'add', '-A')
        git(root, 'commit', '-q', '-m', 'base moves')
        git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr')
        return root

    def skip(self, workflow, root, regex=REGEX, event='pull_request'):
        out = os.path.join(root, '.out')
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': root, 'EVENT': event,
               'IGNORE_REGEX': regex, 'GITHUB_OUTPUT': out}
        done = subprocess.run(['bash', '-e', '-c', script(workflow)], cwd=root, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        values = dict(line.split('=', 1) for line in open(out).read().split())
        return values['skip']

    def each(self, paths, expected, **kw):
        root = self.merge_checkout(paths)
        for workflow in WORKFLOWS:
            with self.subTest(workflow=os.path.basename(workflow)):
                self.assertEqual(self.skip(workflow, root, **kw), expected)

    def test_a_pull_request_of_only_docs_is_docs_only(self):
        self.each(['docs/a.txt', 'docs-new/b/c.html', 'README2.md'], 'true')

    def test_one_code_file_among_docs_is_not_docs_only(self):
        self.each(['docs/a.txt', 'src/App/Program.cs', 'docs/b.txt'], 'false')

    def test_a_long_list_of_code_files_is_not_docs_only(self):
        # About 200 KB of file names: well past the pipe buffer, which is what made the old step fail open.
        self.each([f'src/Modules/Omni237.Modules.Inventory/Domain/Generated/Entity{i:05d}Configuration.cs' for i in range(2500)], 'false')

    def test_a_long_list_with_the_one_code_file_last_is_not_docs_only(self):
        self.each([f'docs/section-{i:05d}/some-long-documentation-page-name-{i:05d}.html' for i in range(3000)] + ['zzz/code.cs'], 'false')

    def test_a_long_list_of_docs_only_files_is_docs_only(self):
        self.each([f'docs/section-{i:05d}/some-long-documentation-page-name-{i:05d}.html' for i in range(3000)], 'true')

    def test_a_regex_grep_cannot_compile_is_not_docs_only(self):
        self.each(['docs/a.txt'], 'false', regex='(')

    def test_a_push_event_or_an_empty_regex_never_skips(self):
        root = self.merge_checkout(['docs/a.txt'])
        for workflow in WORKFLOWS:
            with self.subTest(workflow=os.path.basename(workflow)):
                self.assertEqual(self.skip(workflow, root, event='push'), 'false')
                self.assertEqual(self.skip(workflow, root, regex=''), 'false')


if __name__ == '__main__':
    unittest.main()
