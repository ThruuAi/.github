#!/usr/bin/env python3
"""Mutation proof for pr-gate-v3.test.py.

Each mutant weakens .github/workflows/dotnet-pr-v3.yml in one way a careless edit could (a verdict that passes without
its shards, a plan that accepts an empty matrix, a shard that accepts a filter that selects nothing, a gate that treats
main as dev, ...) in a COPY (PR_GATE_V3_WORKFLOW), and the suite must go red on it. The real file is never written: its
SHA-256 is compared before and after. A mutant whose anchor does not occur the stated number of times is reported as
broken, so a rewritten workflow cannot leave a mutant that silently mutates nothing.

    python3 governance/tests/pr-gate-v3.mutations.py
"""
import concurrent.futures
import hashlib
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(HERE, '..', '..', '.github', 'workflows', 'dotnet-pr-v3.yml')
TEST = os.path.join(HERE, 'pr-gate-v3.test.py')

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


MAIN_AS_TEST = "((github.base_ref == 'test' || github.base_ref == 'main') && 'test' || 'dev')"

MUTANTS = {
    'verdict skipped when the lane fails (success() instead of always())': sub("    if: ${{ always() }}\n", "    if: ${{ success() }}\n"),
    'verdict does not look at the lane': sub('[ "$LANE" = success ] || problem "the lane did not succeed ($LANE)"', 'true'),
    'verdict passes skipped shards': sub('[ "$SHARD" = success ] || problem "not every test shard succeeded ($SHARD)"',
                                         '[ "$SHARD" != failure ] || problem "not every test shard succeeded ($SHARD)"'),
    'verdict passes cancelled shards': sub('[ "$SHARD" = success ] || problem "not every test shard succeeded ($SHARD)"',
                                           '[ "$SHARD" != failure ] && [ "$SHARD" != skipped ] || problem "not every test shard succeeded ($SHARD)"'),
    'verdict passes a failed plan': sub('[ "$PLAN" = success ] || problem "the $GATE gate owes a shard plan and it did not succeed ($PLAN)"', 'true'),
    'verdict accepts a plan with no shards': sub('''case "${COUNT:-}" in ''|*[!0-9]*|0) problem "the $GATE gate has no shards (count='${COUNT:-}')" ;; esac''', 'true'),
    'verdict accepts shards on the dev gate': sub('[ "$PLAN" = skipped ] && [ "$SHARD" = skipped ] ||', 'true ||'),
    'plan accepts an empty matrix': sub('assert isinstance(matrix, list) and matrix, "the plan is empty"', 'assert isinstance(matrix, list)'),
    'plan accepts duplicate labels': sub('assert len(set(labels)) == len(labels), "duplicate shard labels"', 'pass'),
    'plan ignores a failing command': sub('bash -euo pipefail -c "$command" > "$RUNNER_TEMP/matrix.json"', 'bash -euo pipefail -c "$command" > "$RUNNER_TEMP/matrix.json" || true'),
    'plan runs without a command': sub('if [ -z "$command" ]; then', 'if false; then'),
    'plan also runs on dev': sub("github.base_ref == 'uat') }}", "github.base_ref == 'uat' || github.base_ref == 'dev') }}"),
    'plan sees the package token': sub("          COMMAND_UAT: ${{ inputs.shards-uat }}\n", "          COMMAND_UAT: ${{ inputs.shards-uat }}\n          GH_PACKAGES_TOKEN: ${{ secrets.GH_PACKAGES_TOKEN }}\n"),
    'a shard that selects no tests passes': sub('if [ "${total:-0}" -eq 0 ]; then', 'if [ "${total:-0}" -eq -1 ]; then'),
    'a failed shard cancels its siblings': sub('      fail-fast: false\n', '      fail-fast: true\n'),
    'shards run without a green plan': sub("    if: ${{ needs.plan.result == 'success' }}\n", ''),
    'main is treated as dev (gate expression)': sub(MAIN_AS_TEST, "(github.base_ref == 'test' && 'test' || 'dev')", expected=2),
    'uat is treated as test (gate expression)': sub("(github.base_ref == 'uat' && 'uat' || ", "(false && 'uat' || ", expected=2),
    'the off-dev lane keeps the selector': sub('          if [ "$GATE" != dev ]; then all "the $GATE gate runs everything"; exit 0; fi\n', ''),
    'the off-dev lane keeps the docs-only skip': sub("IGNORE_REGEX: ${{ env.GATE == 'dev' && inputs.docs-only-regex || '' }}", 'IGNORE_REGEX: ${{ inputs.docs-only-regex }}'),
    'the code-style step runs off dev too': sub(" && github.event_name == 'pull_request' && env.GATE == 'dev'", " && github.event_name == 'pull_request'"),
}


def run(mutate):
    mutated, problem = mutate(SOURCE)
    if mutated is None:
        return None, problem
    with tempfile.TemporaryDirectory(prefix='pr-gate-v3-mutant-') as tmp:
        path = os.path.join(tmp, 'dotnet-pr-v3.yml')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(mutated)
        done = subprocess.run([sys.executable, TEST], env={**os.environ, 'PR_GATE_V3_WORKFLOW': path}, capture_output=True, text=True, timeout=900)
        return done.returncode, ''


def main():
    survived, broken = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {label: pool.submit(run, mutate) for label, mutate in MUTANTS.items()}
        for label, future in futures.items():
            rc, problem = future.result()
            if rc is None:
                broken.append(label)
                print(f'BROKEN   {label}: {problem}')
            elif rc == 0:
                survived.append(label)
                print(f'SURVIVED {label}')
            else:
                print(f'KILLED   {label}')
    if hashlib.sha256(open(WORKFLOW, 'rb').read()).hexdigest() != DIGEST:
        print('FAIL the real workflow changed during the run')
        return 1
    print(f'{len(MUTANTS) - len(survived) - len(broken)} of {len(MUTANTS)} killed, {len(survived)} survived, {len(broken)} broken')
    return 1 if survived or broken else 0


if __name__ == '__main__':
    sys.exit(main())
