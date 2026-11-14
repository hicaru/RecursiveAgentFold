#!/usr/bin/env bash
# Real-host smoke test for the DSH plugin.
# Boots the installed DeepSeek Harness host (same runtime as the desktop app)
# in an isolated profile and runs one RAF turn end to end.
#
# Usage: packages/benchmarks/scripts/e2e-dsh-host.sh [prompt]
# Exit 0: the host finished the turn with no fatal failure.
#
# Requires: pnpm, the DeepSeek Harness desktop app, and ZAI_API_KEY
# (read from the repo .env when present).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/packages/dsh-plugin"
PROMPT="${1:-Reply with exactly: OK}"
E2E_DIR="${E2E_DIR:-/tmp/raf-e2e}"
ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
APP_ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
ASAR_BIN="$APP_ASAR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
DSH_VERSION="${DSH_VERSION:-0.2.2-rc.3}"

# Only Electron resolves paths inside app.asar; test the archive itself.
if [[ ! -x "$ELECTRON" || ! -f "$APP_ASAR" ]]; then
  echo "DeepSeek Harness app not found at $ELECTRON" >&2
  exit 2
fi

# Credentials: repo .env first, then the inherited environment.
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a; # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"; set +a
fi
if [[ -z "${ZAI_API_KEY:-}" ]]; then
  echo "ZAI_API_KEY is not set; source the repo .env or export it." >&2
  exit 2
fi
export ZAI_CODING_CN_API_KEY="$ZAI_API_KEY"

PROFILE_DIR="$E2E_DIR/dsh-home/profiles/raf-e2e"
STATE_DIR="$E2E_DIR/state"

if [[ ! -d "$PROFILE_DIR/node_modules" ]]; then
  mkdir -p "$PROFILE_DIR" "$STATE_DIR/raf-engine"
  cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-raf-e2e",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "@raf/dsh-plugin"
      ]
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-base": "$DSH_VERSION",
    "@deepseek-ai/dsh-headless": "$DSH_VERSION",
    "@raf/dsh-plugin": "link:$PLUGIN_DIR"
  }
}
EOF
  cat > "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      zai-coding-cn:
        apiKeyEnv: ZAI_CODING_CN_API_KEY
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: zai-coding-cn
    model: glm-5.3
    reasoningEffort: low
EOF
  (cd "$PROFILE_DIR" && pnpm install --store-dir "$E2E_DIR/pnpm-store" --ignore-scripts >/dev/null)
fi

# Every session in this profile runs the RAF engine.
cat > "$STATE_DIR/raf-engine/state.json" <<'EOF'
{
  "version": 1,
  "defaultEngine": "raf",
  "engines": {},
  "settings": {
    "depth": 2, "reserve": 0.3, "concurrency": 4,
    "branchProvider": "", "branchModel": "", "branchReasoningEffort": "",
    "queryProvider": "", "queryModel": "", "deepStudy": false
  }
}
EOF

STDOUT="$E2E_DIR/stdout.log"
STDERR="$E2E_DIR/stderr.log"
set +e
env DSH_HOME="$E2E_DIR/dsh-home" DSH_PROFILE_DIR="$STATE_DIR" ELECTRON_RUN_AS_NODE=1 \
  "$ELECTRON" "$ASAR_BIN" raf-e2e "$PROMPT" >"$STDOUT" 2>"$STDERR"
CODE=$?
set -e

if grep -q "fatal load failure" "$STDERR"; then
  echo "FAIL: host reported a fatal load failure" >&2
  grep -m1 -A6 "fatal load failure" "$STDERR" >&2
  exit 1
fi
if [[ $CODE -ne 0 ]]; then
  echo "FAIL: host exited with $CODE" >&2
  tail -5 "$STDERR" >&2
  exit 1
fi

echo "PASS: exit 0, no fatal, answer: $(head -c 200 "$STDOUT")"
