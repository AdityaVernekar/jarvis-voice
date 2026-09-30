#!/usr/bin/env bash
# Publish tools/jarvis-voice as its own private GitHub repo and invite a collaborator.
# Needs the GitHub CLI, logged in:  brew install gh && gh auth login
#
#   ./publish.sh                        # -> <your-account>/jarvis-voice, invites Ashf03
#   OWNER=Aetheria-Labs1 ./publish.sh   # create under an org instead
#   REPO=jarvis COLLAB=someone VISIBILITY=public ./publish.sh
set -euo pipefail

REPO="${REPO:-jarvis-voice}"
COLLAB="${COLLAB:-Ashf03}"
VISIBILITY="${VISIBILITY:-private}"
PERMISSION="${PERMISSION:-push}"   # pull | triage | push | maintain | admin
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v gh >/dev/null || { echo "Install the GitHub CLI first: brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login"; exit 1; }
OWNER="${OWNER:-$(gh api user -q .login)}"
FULL="$OWNER/$REPO"

# Copy into a clean temp dir so the repo never includes llm-wiki history or .env files.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILES=(jarvis.mjs install.mjs README.md PLAN.md SMALLEST_PLAN.md package.json .gitignore publish.sh)
MSG="${MSG:-Smallest.ai voices, Hinglish and multi-language summaries, engine fallback chain}"

if gh repo view "$FULL" >/dev/null 2>&1; then
  echo "• $FULL exists; pushing an update"
  gh repo clone "$FULL" "$WORK/repo" -- -q
  cd "$WORK/repo"
  for f in "${FILES[@]}"; do cp "$SRC/$f" .; done
  git add -A
  if git diff --cached --quiet; then echo "• nothing changed"; else git commit -q -m "$MSG" && git push -q; fi
else
  for f in "${FILES[@]}"; do cp "$SRC/$f" "$WORK"/; done
  cd "$WORK"
  git init -q -b main
  git add -A
  git commit -q -m "Jarvis voice: spoken pings for Claude Code and Codex CLI"
  gh repo create "$FULL" "--$VISIBILITY" --source . --push \
    --description "Spoken pings for terminal coding agents (Claude Code, Codex CLI)"
fi

gh api -X PUT "repos/$FULL/collaborators/$COLLAB" -f permission="$PERMISSION" >/dev/null
echo "✓ https://github.com/$FULL  ($VISIBILITY)"
echo "✓ Invited $COLLAB with '$PERMISSION' access. They need to accept the email / github.com/notifications invite."
