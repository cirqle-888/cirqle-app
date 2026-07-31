#!/usr/bin/env bash
#
# One-command commit + push for the Cirqle Studio plugin.
#
#   bash push.sh                  → commit everything under figma-plugin/ with
#                                   the default message, then push
#   bash push.sh "your message"   → same, with your own message
#
# Exists because pasting a multi-command line into Terminal kept losing the
# "&&" between the commands, which left zsh treating the whole line as
# arguments to cd ("cd: too many arguments") and nothing actually ran.

set -euo pipefail

cd "$(dirname "$0")"

MSG="${1:-Studio: plugin update}"
# The plugin, plus the app-side files the plugin work reaches into. Anything
# already staged by hand is committed too, so `git add <path>` beforehand
# covers a one-off outside these.
TARGETS=("figma-plugin/cirqle-studio" "src/lib/ai" "src/app/api/figma")

echo "→ repo:   $(pwd)"
echo "→ branch: $(git rev-parse --abbrev-ref HEAD)"

for target in "${TARGETS[@]}"; do
  [ -e "$target" ] && git add "$target"
done

if git diff --cached --quiet; then
  echo "Nothing to commit — the working tree already matches the last commit."
  exit 0
fi

echo
echo "Staged:"
git diff --cached --name-status

echo
git commit -m "$MSG"
git push

echo
echo "✓ Pushed to $(git rev-parse --abbrev-ref HEAD): $MSG"
