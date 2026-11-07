#!/bin/bash
# Публикует папку telegram/ в новый публичный репозиторий GitHub.
set -euo pipefail
cd "$(dirname "$0")"
NAME="${1:-flow-telegram}"

if ! command -v gh >/dev/null; then
  if command -v brew >/dev/null; then echo "Ставлю GitHub CLI…"; brew install gh
  else echo "❌ Нужен GitHub CLI: https://cli.github.com (или поставь Homebrew)"; exit 1; fi
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Вход в GitHub: выбери GitHub.com → HTTPS → Login with a web browser, скопируй код и вставь в браузере."
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git

if [ ! -d .git ]; then git init -q -b main; fi
git add -A
git -c user.name="$(gh api user --jq .login)" -c user.email="$(gh api user --jq .login)@users.noreply.github.com" \
  commit -qm "FLOW: Telegram-бот и мини-апп (автомикс, мэшапы, светомузыка)" || true
if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main
else
  gh repo create "$NAME" --public --source=. --remote=origin --push --description "FLOW — карманный диджей в Telegram: автомикс, мэшапы на нейросети, светомузыка"
fi
echo
echo "✅ Готово: $(gh repo view --json url --jq .url)"
