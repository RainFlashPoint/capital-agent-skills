#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${CAPITAL_AGENT_NODE_BIN:-}"
LOCAL_MODE=false
for argument in "$@"; do
  if [[ "$argument" == "--local" ]]; then LOCAL_MODE=true; fi
done
MIN_NODE_VERSION=$([[ "$LOCAL_MODE" == true ]] && echo "18.0.0" || echo "20.18.1")
INSTALL_EXAMPLE=$([[ "$LOCAL_MODE" == true ]] && echo "--local" || echo '--server "https://your-server"')

node_is_compatible() {
  [[ -x "$1" ]] && "$1" -p "const [a,b,c]=process.versions.node.split('.').map(Number); const [x,y,z]='${MIN_NODE_VERSION}'.split('.').map(Number); Number(a>x||(a===x&&(b>y||(b===y&&c>=z))))" 2>/dev/null | grep -qx 1
}

if [[ -n "$NODE_BIN" ]] && ! node_is_compatible "$NODE_BIN"; then
  echo "CAPITAL_AGENT_NODE_BIN 指向的 Node 不兼容：$($NODE_BIN --version 2>/dev/null || echo unknown)，最低需要 ${MIN_NODE_VERSION}。" >&2
  exit 1
fi

if [[ -z "$NODE_BIN" ]]; then
  candidates=()
  if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
  candidates+=(/opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node")
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    while IFS= read -r candidate; do candidates+=("$candidate"); done < <(find "$HOME/.nvm/versions/node" -type f -path '*/bin/node' -perm -111 2>/dev/null | sort -Vr)
  fi
  if [[ -d "$HOME/.cache/codex-runtimes" ]]; then
    while IFS= read -r candidate; do candidates+=("$candidate"); done < <(find "$HOME/.cache/codex-runtimes" -type f -path '*/dependencies/node/bin/node' -perm -111 2>/dev/null)
  fi
  for candidate in "${candidates[@]}"; do
    if node_is_compatible "$candidate"; then NODE_BIN="$candidate"; break; fi
  done
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  cat >&2 <<EOF
Capital Agent 当前安装模式需要 Node.js ${MIN_NODE_VERSION} 或更高版本，但当前机器未找到兼容版本。

macOS 可执行：
  brew install node

如果 Node 已安装但不在 PATH，请这样运行：
  CAPITAL_AGENT_NODE_BIN=/Node/绝对路径 bash scripts/setup.sh ${INSTALL_EXAMPLE} --upgrade
EOF
  exit 127
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"
exec "$NODE_BIN" "$SCRIPT_DIR/setup.mjs" "$@"
