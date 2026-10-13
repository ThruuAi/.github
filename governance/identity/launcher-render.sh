#!/usr/bin/env bash
# Pure launcher bytes for installer/doctor; no identity, file or network work.
mm_launcher_q() { LC_ALL=C printf '%q' "$1"; }
mm_render_launcher() {
  [[ $# -eq 5 ]] || return 2
  local file="$1" profile="$2" revision="$3" real="$4" root="$5" lib
  case "$file" in gh | mm-gh-org) ;; *) return 2 ;; esac
  case "$profile" in mm-agent | mm-reviewer) ;; *) return 2 ;; esac
  [[ "$revision" =~ ^[0-9a-f]{40}$ && "$real" == /* && "$root" == /* ]] || return 2
  [[ "$real" != *$'\n'* && "$root" != *$'\n'* ]] || return 2
  lib="$root/$profile/shim/$revision/libexec"
  printf '#!/usr/bin/env bash\n# Written by agent-env.sh from commit %s.\n' "$revision"
  if [[ "$file" == gh ]]; then
    printf "unset MM_GH_ORG\nexec %s %s %s \"\$@\"\n" "$(mm_launcher_q "$lib/gh-shim.sh")" "$(mm_launcher_q "$profile")" "$(mm_launcher_q "$real")"
  else
    cat <<'MM_ORG'
org="${1:-}"; case "$org" in marvinamiranda | ThruuAi) ;; *) echo "usage: mm-gh-org <marvinamiranda|ThruuAi> <gh arguments...>" >&2; exit 2 ;; esac
shift
MM_ORG
    printf "MM_GH_ORG=\"\$org\" exec %s %s %s \"\$@\"\n" "$(mm_launcher_q "$lib/gh-shim.sh")" "$(mm_launcher_q "$profile")" "$(mm_launcher_q "$real")"
  fi
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  mm_render_launcher "$@" || { printf 'launcher-render: InvalidArguments\n' >&2; exit 2; }
fi
