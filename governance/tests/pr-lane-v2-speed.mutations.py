#!/usr/bin/env python3
"""Mutation proof for pr-lane-v2-speed.test.py.

Each mutant weakens .github/workflows/dotnet-pr-v2.yml in one way a careless edit could, in a COPY
(PR_LANE_V2_WORKFLOW), and the suite must go red on it. The real file is never written: its SHA-256 is compared
before and after. A mutant whose anchor does not occur the stated number of times is reported as broken, so a
rewritten workflow cannot leave a mutant that silently mutates nothing.

    python3 governance/tests/pr-lane-v2-speed.mutations.py
"""
import hashlib
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-pr-v2.yml')
TEST = os.path.join(HERE, 'pr-lane-v2-speed.test.py')

with open(WORKFLOW, encoding='utf-8') as handle:
    SOURCE = handle.read()
DIGEST = hashlib.sha256(SOURCE.encode()).hexdigest()


def sub(anchor, replacement, expected=1):
    def mutate(text):
        count = text.count(anchor)
        if count != expected:
            return None, f'the anchor occurs {count} times, expected {expected}'
        return text.replace(anchor, replacement), None
    return mutate


def move_join_after_build(text):
    start = text.index('      # The join of `static-checks-background`')
    end = text.index('      # The ONLY step that sees the package token.')
    block = text[start:end]
    text = text[:start] + text[end:]
    marker = '      # Style and whitespace on the changed files only'
    if text.count(marker) != 1:
        return None, 'the Code style anchor is not unique'
    return text.replace(marker, block + marker), None


def move_sdk_after_static(text):
    start = text.index('      # `global-json-sdk` (first')
    end = text.index('      # Runs on docs-only changes too')
    block = text[start:end]
    text = text[:start] + text[end:]
    marker = '      # What does this change need?'
    if text.count(marker) != 1:
        return None, 'the selector anchor is not unique'
    return text.replace(marker, block + marker), None


INSTALL_IF = "        if: steps.scope.outputs.skip != 'true' && inputs.incremental && inputs.global-json-sdk\n"
JOIN_IF = "        if: ${{ !cancelled() && inputs.static-checks != '' && inputs.static-checks-background }}\n"
SWITCH_DEFAULT = "        type: boolean\n        required: false\n        default: false\n"

MUTANTS = [
    ('the SDK install no longer needs the switch (every caller gets it)',
     sub(INSTALL_IF, "        if: steps.scope.outputs.skip != 'true' && inputs.incremental\n")),
    ('the SDK install runs on a docs-only change too',
     sub(INSTALL_IF, "        if: inputs.incremental && inputs.global-json-sdk\n")),
    ('the SDK is installed into the image folder, not a job-private one',
     sub("DOTNET_INSTALL_DIR: ${{ runner.temp }}/dotnet", "DOTNET_INSTALL_DIR: /usr/share/dotnet")),
    ('the SDK install ignores global.json (a literal version)',
     sub("        with:\n          global-json-file: global.json\n\n      # Without", "        with:\n          dotnet-version: 10.0.115\n\n      # Without")),
    ('the version check no longer compares with global.json',
     sub('            if [ "$v" != "$want" ]; then', '            if false; then')),
    ('the version check accepts any 10.0.x',
     sub('            if [ "$v" != "$want" ]; then', '            if [ "${v%.*}" != "${want%.*}" ]; then')),
    ('the version check reads the switch wrongly (never checks)',
     sub('          if [ "$PINNED" = "true" ]; then', '          if [ "$PINNED" = "never" ]; then')),
    ('the join step is dropped',
     lambda t: (t[:t.index('      # The join of `static-checks-background`')] + t[t.index('      # The ONLY step that sees the package token.'):], None)),
    ('the join no longer runs after a failure or when docs-only (default success() only)',
     sub(JOIN_IF, "        if: inputs.static-checks != '' && inputs.static-checks-background\n")),
    ('the join is skipped on a docs-only change',
     sub(JOIN_IF, "        if: ${{ !cancelled() && steps.scope.outputs.skip != 'true' && inputs.static-checks-background }}\n")),
    ('the join runs even when the switch is off',
     sub(JOIN_IF, "        if: ${{ !cancelled() && inputs.static-checks != '' }}\n")),
    ('the SDK install runs after the static checks started (the download shares the runner with them)', move_sdk_after_static),
    ('the join sits after the build (a failed check no longer stops the expensive steps)', move_join_after_build),
    ('the join ignores a non-zero exit status of the checks',
     sub('          if [ "$rc" != "0" ]; then\n            echo "::error::the static checks failed (exit status $rc)"\n            exit 1\n          fi\n', '')),
    ('the join passes when the checks never started',
     sub('            if [ ! -s "$dir/pid" ]; then echo "FAIL the static checks were never started" >&2; exit 1; fi\n', '')),
    ('the join waits forever for a process that died',
     sub('              echo "FAIL the static checks process is gone without a result" >&2\n              cat "$dir/log" 2>/dev/null || true\n              exit 1\n', '              :\n')),
    ('the join gives no log on a failure path',
     sub('          cat "$dir/log"\n          rc=', '          rc=')),
    ('the wrapper records a pass whatever the script did',
     sub('echo $? > "$1/rc.tmp"', 'echo 0 > "$1/rc.tmp"')),
    ('the script runs without -e in the background (the first failure no longer stops it)',
     sub('bash -euo pipefail "$1/checks.sh"', 'bash -uo pipefail "$1/checks.sh"')),
    ('the script runs without pipefail in the background',
     sub('bash -euo pipefail "$1/checks.sh"', 'bash -eu "$1/checks.sh"')),
    ('the foreground path is gone: the checks always go to the background',
     sub('          if [ "$BACKGROUND" != "true" ]; then\n            bash -euo pipefail -c "$CHECKS"\n            exit\n          fi\n', '')),
    ('the package token reaches the join step',
     sub('      - name: Static checks (result)\n        if: ${{ !cancelled() && inputs.static-checks != \'\' && inputs.static-checks-background }}\n',
         '      - name: Static checks (result)\n        if: ${{ !cancelled() && inputs.static-checks != \'\' && inputs.static-checks-background }}\n        env:\n          GH_PACKAGES_TOKEN: ${{ secrets.GH_PACKAGES_TOKEN }}\n')),
    ('the background switch defaults to true',
     sub("      static-checks-background:\n        description: >-\n          Start `static-checks` in the background and join it in the `Static checks (result)` step, just before the\n          restore, so the checks overlap the NuGet cache download. The job still fails when they fail, never\n          start, or end without a result. Default false: the checks run to completion first, as before.\n" + SWITCH_DEFAULT,
         "      static-checks-background:\n        description: >-\n          x\n        type: boolean\n        required: false\n        default: true\n")),
    ('the SDK switch defaults to true',
     sub("          producer and lane used the same SDK at the same path. Default false: the image's SDK, as before.\n" + SWITCH_DEFAULT,
         "          producer and lane used the same SDK at the same path. Default false: the image's SDK, as before.\n        type: boolean\n        required: false\n        default: true\n")),
]


def run(path):
    env = dict(os.environ, PR_LANE_V2_WORKFLOW=path)
    return subprocess.run([sys.executable, TEST], capture_output=True, text=True, env=env)


baseline = run(WORKFLOW)
print(f'baseline: exit {baseline.returncode} (must be 0)')
bad = 1 if baseline.returncode != 0 else 0
workdir = tempfile.mkdtemp(prefix='pr-lane-speed-mut-')
for name, mutate in MUTANTS:
    mutated, error = mutate(SOURCE)
    if error or mutated == SOURCE:
        bad += 1
        print(f'BROKEN MUTANT - {name}: {error or "nothing changed"}')
        continue
    path = os.path.join(workdir, 'mutant.yml')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(mutated)
    result = run(path)
    red = result.returncode != 0
    failing = next((l for l in result.stderr.splitlines() if l.startswith(('FAIL:', 'ERROR:'))), '')[:110]
    if not red:
        bad += 1
    print(f"{'killed  ' if red else 'SURVIVED'} - {name}{('  [' + failing + ']') if red else ''}")
if os.path.exists(os.path.join(workdir, 'mutant.yml')):
    os.remove(os.path.join(workdir, 'mutant.yml'))
os.rmdir(workdir)
with open(WORKFLOW, 'rb') as handle:
    after = hashlib.sha256(handle.read()).hexdigest()
print(f'workflow file untouched: {after == DIGEST} ({after[:12]})')
bad += 0 if after == DIGEST else 1
print(f'{len(MUTANTS)} mutants, {bad} problem(s)')
sys.exit(1 if bad else 0)
