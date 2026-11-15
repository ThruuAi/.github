#!/usr/bin/env python3
"""Mutation proof for docs-only-classification.test.py (ThruuAi/.github#11).

Each mutant re-introduces, in a COPY of dotnet-pr.yml and dotnet-pr-v2.yml, one way the "Docs-only change" step can
call a pull request docs-only when it is not; the test must go red on every one. The real files are never written
(their SHA-256 is compared before and after). A mutant whose anchor does not occur once per file is reported as
broken, so a rewritten step cannot leave a mutant that silently mutates nothing.

    python3 governance/tests/docs-only-classification.mutations.py
"""
import hashlib
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '.github', 'workflows')
NAMES = ('dotnet-pr.yml', 'dotnet-pr-v2.yml', 'dotnet-pr-v3.yml')
TEST = os.path.join(HERE, 'docs-only-classification.test.py')

PRISTINE = {n: open(os.path.join(ROOT, n), encoding='utf-8').read() for n in NAMES}
DIGEST = {n: hashlib.sha256(t.encode()).hexdigest() for n, t in PRISTINE.items()}

DECIDE = '''              rc=0
              # Captured, not sent to /dev/null: GNU grep stops at the first match when its output is /dev/null.
              # shellcheck disable=SC2034  # captured only so that grep reads all of its input
              others="$(printf '%s\\n' "$files" | grep -Ev -- "$IGNORE_REGEX")" || rc=$?
              if [ "$rc" -eq 1 ]; then
'''
OLD_SHAPE = '''              if ! printf '%s\\n' "$files" | grep -Eqv -- "$IGNORE_REGEX"; then
'''

MUTANTS = {
    # the original defect: grep -q stops early, printf dies on the closed pipe, pipefail fails the pipeline, `!` says yes
    'grep -q with pipefail (the 2026-11-14 defect)': (DECIDE, OLD_SHAPE),
    # a grep that fails (bad regex) counts as "nothing left"
    'grep error counts as docs-only': ('if [ "$rc" -eq 1 ]; then', 'if [ "$rc" -ne 0 ]; then'),
    # "some file is not docs" (grep exit 0) counts as docs-only
    'a remaining code file counts as docs-only': ('if [ "$rc" -eq 1 ]; then', 'if [ "$rc" -le 1 ]; then'),
}


def run(mutant):
    anchor, replacement = mutant
    with tempfile.TemporaryDirectory(prefix='docs-only-mutant-') as tmp:
        paths = []
        for name, text in PRISTINE.items():
            if text.count(anchor) != 1:
                return None, f'{name}: the anchor occurs {text.count(anchor)} times, expected 1'
            path = os.path.join(tmp, name)
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write(text.replace(anchor, replacement))
            paths.append(path)
        done = subprocess.run([sys.executable, TEST], env={**os.environ, 'DOCS_ONLY_WORKFLOWS': os.pathsep.join(paths)},
                              capture_output=True, text=True, timeout=600)
        return done.returncode, (done.stdout + done.stderr)[-400:]


def main():
    broken = survived = 0
    for label, mutant in MUTANTS.items():
        rc, tail = run(mutant)
        if rc is None:
            print(f'BROKEN   {label}: {tail}')
            broken += 1
        elif rc == 0:
            print(f'SURVIVED {label}: the test stayed green')
            survived += 1
        else:
            print(f'KILLED   {label}')
    for name in NAMES:
        after = hashlib.sha256(open(os.path.join(ROOT, name), 'rb').read()).hexdigest()
        if after != DIGEST[name]:
            print(f'FAIL the real {name} changed during the run')
            return 1
    print(f'{survived} survived, {broken} broken')
    return 1 if survived or broken else 0


if __name__ == '__main__':
    sys.exit(main())
