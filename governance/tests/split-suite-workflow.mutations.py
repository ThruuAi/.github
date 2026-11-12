#!/usr/bin/env python3
"""Mutation proof for split-suite-workflow.test.py.

Each mutant weakens .github/workflows/dotnet-split-suite.yml in one way a careless edit could, in a
COPY (SPLIT_SUITE_WORKFLOW), and the suite must go red on it. The real file is never written: its
SHA-256 is compared before and after. A mutant whose anchor does not occur the stated number of times is
reported as broken, so a rewritten workflow cannot leave a mutant that silently mutates nothing.

    python3 governance/tests/split-suite-workflow.mutations.py
"""
import hashlib
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-split-suite.yml')
TEST = os.path.join(HERE, 'split-suite-workflow.test.py')

SOURCE = open(WORKFLOW, encoding='utf-8').read()
DIGEST = hashlib.sha256(SOURCE.encode()).hexdigest()

EXPORT_STEP = """      - name: Use job-owned .NET and NuGet locations
        run: |
          printf 'DOTNET_INSTALL_DIR=%s/dotnet\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"
          printf 'DOTNET_CLI_HOME=%s/dotnet-home\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"
          printf 'NUGET_PACKAGES=%s/nuget-packages\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"
          printf 'NUGET_HTTP_CACHE_PATH=%s/nuget-http-cache\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"

"""
SETUP = """      - name: Setup .NET (SDK from global.json, NuGet cache)
        uses: actions/setup-dotnet"""


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


def mutate_export_moved_after_setup(text):
    # In `build` (the first occurrence): drop the export step from the top and put it after setup-dotnet.
    text, err = nth(text, EXPORT_STEP, '', 0, 2)
    if err:
        return None, err
    marker = "      - name: Restore\n"
    if text.count(marker) != 1:
        return None, 'the Restore step anchor is not unique'
    return text.replace(marker, EXPORT_STEP + marker), None


MUTANTS = [
    ('the shard job does not export the four variables (step removed)',
     lambda t: nth(t, EXPORT_STEP, '', 1, 2)),
    ('the build job exports them AFTER setup-dotnet',
     mutate_export_moved_after_setup),
    ('one job drops DOTNET_CLI_HOME (the user NuGet.Config stays readable)',
     lambda t: nth(t, """          printf 'DOTNET_CLI_HOME=%s/dotnet-home\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"\n""", '', 1, 2)),
    ('one job points NUGET_PACKAGES outside RUNNER_TEMP',
     lambda t: nth(t, """printf 'NUGET_PACKAGES=%s/nuget-packages\\n' "$RUNNER_TEMP" """,
                   """printf 'NUGET_PACKAGES=%s/.nuget/packages\\n' "$HOME" """, 1, 2)),
    ('the check accepts any folder (the RUNNER_TEMP pattern becomes a catch-all)',
     lambda t: nth(t, """              "$RUNNER_TEMP"/?*) ;;\n""", """              *) ;;\n""", 1, 2)),
    ('the check no longer rejects ..',
     lambda t: nth(t, """              *..*) echo "FAIL $name contains '..'" >&2; exit 1 ;;\n""", '', 1, 2)),
    ('the check only looks at NUGET_PACKAGES',
     lambda t: nth(t, 'for name in DOTNET_INSTALL_DIR DOTNET_CLI_HOME NUGET_PACKAGES NUGET_HTTP_CACHE_PATH; do',
                   'for name in NUGET_PACKAGES; do', 1, 2)),
    ('the check lets an empty RUNNER_TEMP through',
     lambda t: nth(t, """          if [ -z "${RUNNER_TEMP:-}" ]; then\n            echo "FAIL RUNNER_TEMP is unset or empty" >&2\n            exit 1\n          fi\n""", '', 1, 2)),
    ('a checkout is not clean',
     lambda t: nth(t, "          clean: true\n", '', 1, 2)),
    ('the shard caches NuGet on every runner (cache: true)',
     lambda t: nth(t, "          cache: ${{ runner.environment == 'github-hosted' }}\n", "          cache: true\n", 1, 2)),
    ('one job runs on `inputs.runner` alone, ignoring the group',
     lambda t: nth(t, "runs-on: ${{ inputs.runner-group != '' && fromJSON(format('{{\"group\":{0},\"labels\":[{1}]}}', toJSON(inputs.runner-group), toJSON(inputs.runner))) || inputs.runner }}",
                   'runs-on: ${{ inputs.runner }}', 2, 3)),
    ('runner-group becomes required',
     lambda t: nth(t, "        type: string\n        required: false\n        default: \"\"\n", "        type: string\n        required: true\n        default: \"\"\n", 1, 2)),
    ('runner-group defaults to a group',
     lambda t: nth(t, "        required: false\n        default: \"\"\n", "        required: false\n        default: \"omni237-nightly\"\n", 1, 2)),
    ('summary starts running dotnet without the steps',
     lambda t: nth(t, '          echo "build: $BUILD; shards: $SHARDS"\n', '          echo "build: $BUILD; shards: $SHARDS"\n          dotnet --info\n', 0, 1)),
]


def run(path):
    env = dict(os.environ, SPLIT_SUITE_WORKFLOW=path)
    return subprocess.run([sys.executable, TEST], capture_output=True, text=True, env=env)


baseline = run(WORKFLOW)
print(f'baseline: exit {baseline.returncode} (must be 0)')
bad = 1 if baseline.returncode != 0 else 0
workdir = tempfile.mkdtemp(prefix='split-suite-mut-')
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
os.remove(os.path.join(workdir, 'mutant.yml')) if os.path.exists(os.path.join(workdir, 'mutant.yml')) else None
os.rmdir(workdir)
after = hashlib.sha256(open(WORKFLOW, 'rb').read()).hexdigest()
print(f'workflow file untouched: {after == DIGEST} ({after[:12]})')
bad += 0 if after == DIGEST else 1
print(f'{len(MUTANTS)} mutants, {bad} problem(s)')
sys.exit(1 if bad else 0)
