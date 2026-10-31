#!/usr/bin/env bash
# チェックを通ったものだけを GitHub へ一括プッシュし、公開を確認するまでが1セット。
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/check.sh

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: 未コミットの変更があります。テストした内容と配る内容を一致させるため、先にコミットしてください" >&2
  exit 1
fi

MANIFEST="$(mktemp)"
git ls-files --cached -z -- . \
  ':(glob,exclude)**/*.muse-github-snapshot-sync.json' \
  ':(glob,exclude)**/*.muse-github-snapshot-sync.json.tmp-*' > "$MANIFEST"

/opt/hatch/bin/github push-files \
  --owner higurashi-999 --repo angel-demon --branch main \
  --message "${1:-update}" \
  --source-dir "$PWD" \
  --paths-file "$MANIFEST"

echo "== 公開確認 =="
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w "%{http_code}" https://higurashi-999.github.io/angel-demon/js/session.js || true)
  [ "$code" = "200" ] && break
  sleep 10
done
curl -s https://higurashi-999.github.io/angel-demon/ | grep -o '<title>[^<]*</title>'
echo "DEPLOYED: https://higurashi-999.github.io/angel-demon/"
