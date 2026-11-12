#!/usr/bin/env python3
"""Mutation proof for pr-lane-v2-workflow.test.py.

Each mutant weakens .github/workflows/dotnet-pr-v2.yml in one way a careless edit could, in a COPY
(PR_LANE_V2_WORKFLOW), and the suite must go red on it. The real file is never written: its SHA-256 is compared
before and after. A mutant whose anchor does not occur the stated number of times is reported as broken, so a
rewritten workflow cannot leave a mutant that silently mutates nothing.

    python3 governance/tests/pr-lane-v2-workflow.mutations.py
"""
import hashlib
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-pr-v2.yml')
TEST = os.path.join(HERE, 'pr-lane-v2-workflow.test.py')

SOURCE = open(WORKFLOW, encoding='utf-8').read()
DIGEST = hashlib.sha256(SOURCE.encode()).hexdigest()

IF = "        if: inputs.job-private-nuget\n"
EXPORT_STEP = """      - name: Use job-owned NuGet locations
        if: inputs.job-private-nuget
        run: |
          printf 'NUGET_PACKAGES=%s/nuget-packages\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"
          printf 'NUGET_HTTP_CACHE_PATH=%s/nuget-http-cache\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"

"""
CACHE_PATH = "path: ${{ inputs.job-private-nuget && format('{0}/nuget-packages', runner.temp) || '~/.nuget/packages' }}"


def nth(text, anchor, replacement, which, expected):
    """Replace only the `which`-th occurrence (0-based) of an anchor that occurs `expected` times."""
    count = text.count(anchor)
    if count != expected:
        return None, f'the anchor occurs {count} times, expected {expected}'
    parts = text.split(anchor)
    out = parts[0]
    for i, part in enumerate(parts[1:]):
        out += (replacement if i == which else anchor) + part
    return out, None


def export_after_checkout(text):
    text, err = nth(text, EXPORT_STEP, '', 0, 1)
    if err:
        return None, err
    marker = "      - name: Docs-only change\n"
    if text.count(marker) != 1:
        return None, 'the Docs-only step anchor is not unique'
    return text.replace(marker, EXPORT_STEP + marker), None


MUTANTS = [
    ('the export step is removed', lambda t: nth(t, EXPORT_STEP, '', 0, 1)),
    ('the export runs AFTER the checkout', export_after_checkout),
    ('the export step always runs (the input no longer gates it)', lambda t: nth(t, IF, '', 0, 2)),
    ('the check step always runs', lambda t: nth(t, IF, '', 1, 2)),
    ('NUGET_PACKAGES points outside RUNNER_TEMP',
     lambda t: nth(t, """printf 'NUGET_PACKAGES=%s/nuget-packages\\n' "$RUNNER_TEMP" """,
                   """printf 'NUGET_PACKAGES=%s/.nuget/packages\\n' "$HOME" """, 0, 1)),
    ('NUGET_HTTP_CACHE_PATH is no longer exported',
     lambda t: nth(t, """          printf 'NUGET_HTTP_CACHE_PATH=%s/nuget-http-cache\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"\n""", '', 0, 1)),
    ('the check accepts any folder (the RUNNER_TEMP pattern becomes a catch-all)',
     lambda t: nth(t, """              "$RUNNER_TEMP"/?*) ;;\n""", """              *) ;;\n""", 0, 1)),
    ('the check no longer rejects ..',
     lambda t: nth(t, """              *..*) echo "FAIL $name contains '..'" >&2; exit 1 ;;\n""", '', 0, 1)),
    ('the check only looks at NUGET_PACKAGES',
     lambda t: nth(t, 'for name in NUGET_PACKAGES NUGET_HTTP_CACHE_PATH; do', 'for name in NUGET_PACKAGES; do', 0, 1)),
    ('the check lets an empty RUNNER_TEMP through',
     lambda t: nth(t, """          if [ -z "${RUNNER_TEMP:-}" ]; then\n            echo "FAIL RUNNER_TEMP is unset or empty" >&2\n            exit 1\n          fi\n""", '', 0, 1)),
    ('the cache path ignores the input (always ~/.nuget/packages)',
     lambda t: nth(t, CACHE_PATH, "path: ~/.nuget/packages", 0, 1)),
    ('the cache path ignores the input (always the job-private folder: default flipped on)',
     lambda t: nth(t, CACHE_PATH, "path: ${{ runner.temp }}/nuget-packages", 0, 1)),
    ('the cache path names a different folder than the export',
     lambda t: nth(t, "format('{0}/nuget-packages', runner.temp)", "format('{0}/nuget-pkgs', runner.temp)", 0, 1)),
    ('the cache key changes (the producer\'s caches are no longer found)',
     lambda t: nth(t, "key: nuget-${{ runner.os }}-${{ hashFiles(inputs.cache-dependency-path) }}",
                   "key: nuget-v2-${{ runner.os }}-${{ hashFiles(inputs.cache-dependency-path) }}", 0, 1)),
    ('the input defaults to true',
     lambda t: nth(t, "        type: boolean\n        required: false\n        default: false\n      timeout-minutes:",
                   "        type: boolean\n        required: false\n        default: true\n      timeout-minutes:", 0, 1)),
    ('the input becomes required',
     lambda t: nth(t, "        type: boolean\n        required: false\n        default: false\n      timeout-minutes:",
                   "        type: boolean\n        required: true\n        default: false\n      timeout-minutes:", 0, 1)),
    ('the job env sets NUGET_PACKAGES for every caller',
     lambda t: nth(t, '      MSBUILDDISABLENODEREUSE: "1"\n', '      MSBUILDDISABLENODEREUSE: "1"\n      NUGET_PACKAGES: /home/runner/.nuget/packages\n', 0, 1)),
    ('the static checks step is dropped',
     lambda t: nth(t, "      - name: Static checks\n        if: inputs.static-checks != ''\n        env:\n          CHECKS: ${{ inputs.static-checks }}\n        run: bash -euo pipefail -c \"$CHECKS\"\n\n", '', 0, 1)),
    ('the package token moves to the job env (reaches build and tests)',
     lambda t: nth(t, '      MSBUILDDISABLENODEREUSE: "1"\n', '      MSBUILDDISABLENODEREUSE: "1"\n      GH_PACKAGES_TOKEN: ${{ secrets.GH_PACKAGES_TOKEN }}\n', 0, 1)),
    ('the runner default changes',
     lambda t: nth(t, "        default: ubuntu-24.04\n", "        default: ubuntu-latest\n", 0, 1)),
]


def run(path):
    env = dict(os.environ, PR_LANE_V2_WORKFLOW=path)
    return subprocess.run([sys.executable, TEST], capture_output=True, text=True, env=env)


baseline = run(WORKFLOW)
print(f'baseline: exit {baseline.returncode} (must be 0)')
bad = 1 if baseline.returncode != 0 else 0
workdir = tempfile.mkdtemp(prefix='pr-lane-mut-')
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
after = hashlib.sha256(open(WORKFLOW, 'rb').read()).hexdigest()
print(f'workflow file untouched: {after == DIGEST} ({after[:12]})')
bad += 0 if after == DIGEST else 1
print(f'{len(MUTANTS)} mutants, {bad} problem(s)')
sys.exit(1 if bad else 0)
