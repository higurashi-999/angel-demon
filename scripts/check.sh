#!/usr/bin/env bash
# デプロイ前チェック: 構文・全テスト・プッシュ制約を検証する。失敗したら非ゼロで止まる。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 構文チェック =="
for f in js/*.js sw.js; do node --check "$f"; done
echo "syntax OK"

echo "== 依存関係 =="
if [ ! -d node_modules/jsdom ]; then npm install --no-audit --no-fund; fi

echo "== テスト =="
node --test "tests/*.test.js"

echo "== プッシュ制約チェック =="
# Muse の GitHub App には Workflows 権限がなく、.github/workflows/ を含むプッシュは 403 になる
if git ls-files | grep -q '^\.github/workflows/'; then
  echo "ERROR: .github/workflows/ 配下のファイルが追跡されています" >&2
  exit 1
fi
echo "ALL CHECKS PASSED"
