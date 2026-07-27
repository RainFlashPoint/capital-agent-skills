#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${CAPITAL_AGENT_NODE_BIN:-}"

if [[ -z "$NODE_BIN" ]] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [[ -z "$NODE_BIN" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi

if [[ -z "$NODE_BIN" && -d "$HOME/.nvm/versions/node" ]]; then
  NODE_BIN="$(find "$HOME/.nvm/versions/node" -type f -path '*/bin/node' -perm -111 2>/dev/null | sort -V | tail -1)"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  cat >&2 <<'EOF'
Capital Agent 安装需要 Node.js 18 或更高版本，但当前 Shell 未找到 node。

macOS 可执行：
  brew install node

如果 Node 已安装但不在 PATH，请这样运行：
  CAPITAL_AGENT_NODE_BIN=/Node/绝对路径 bash scripts/setup.sh --server "https://your-server" --upgrade
EOF
  exit 127
fi

MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$MAJOR" =~ ^[0-9]+$ || "$MAJOR" -lt 18 ]]; then
  echo "Capital Agent 需要 Node.js 18+，当前为 $($NODE_BIN --version)。" >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/setup.mjs" "$@"
