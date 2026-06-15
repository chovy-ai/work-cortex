#!/usr/bin/env bash
# 更新被分析应用的本地 monorepo。
# 仓库地址（app.repo.url）与默认本地路径（app.repo.localPath）都来自
# data-analysis 根目录的 app.config.json —— 接入新应用时只改那个文件。
# 可用 APP_REPO_PATH 环境变量临时覆盖本地路径。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 向上查找含 app.config.json 的 data-analysis 根目录
ROOT="$SCRIPT_DIR"
while [[ "$ROOT" != "/" && ! -f "$ROOT/app.config.json" ]]; do
  ROOT="$(dirname "$ROOT")"
done
if [[ ! -f "$ROOT/app.config.json" ]]; then
  echo "找不到 app.config.json（data-analysis 根）" >&2
  exit 1
fi
CONFIG="$ROOT/app.config.json"

read_cfg() { node -e "process.stdout.write(String(require('$CONFIG')$1))"; }
APP_NAME="$(read_cfg ".app.name")"
REPO_URL="$(read_cfg ".app.repo.url")"
CFG_LOCAL="$(read_cfg ".app.repo.localPath")"

# 解析本地路径：环境变量覆盖 > 配置值（相对路径相对 ROOT 解析）
RAW_PATH="${APP_REPO_PATH:-$CFG_LOCAL}"
case "$RAW_PATH" in
  /*) REPO_PATH="$RAW_PATH" ;;
  "~"*) REPO_PATH="${RAW_PATH/#\~/$HOME}" ;;
  *)  REPO_PATH="$ROOT/$RAW_PATH" ;;
esac

if [[ -d "$REPO_PATH/.git" ]]; then
  ORIGIN="$(git -C "$REPO_PATH" remote get-url origin 2>/dev/null || echo "$REPO_URL")"
  echo "Pulling $APP_NAME from $ORIGIN …"
  git -C "$REPO_PATH" pull --ff-only
  echo "Done. Commit: $(git -C "$REPO_PATH" rev-parse --short HEAD)"
else
  echo "$APP_NAME repo not found at $REPO_PATH. Cloning $REPO_URL …"
  git clone "$REPO_URL" "$REPO_PATH"
  echo "Cloned. Commit: $(git -C "$REPO_PATH" rev-parse --short HEAD)"
fi
