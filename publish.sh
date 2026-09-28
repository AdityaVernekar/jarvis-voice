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
cp "$SRC"/{jarvis.mjs,install.mjs,README.md,PLAN.md,package.json,.gitignore,publish.sh} "$WORK"/
cd "$WORK"
git init -q -b main
git add -A
git commit -q -m "Jarvis voice: spoken pings for Claude Code and Codex CLI"

if gh repo view "$FULL" >/dev/null 2>&1; then
  echo "• $FULL already exists; pushing to it"
  git remote add origin "https://github.com/$FULL.git"
  git push -u origin main
else
  gh repo create "$FULL" "--$VISIBILITY" --source . --push \
    --description "Spoken pings for terminal coding agents (Claude Code, Codex CLI)"
fi

gh api -X PUT "repos/$FULL/collaborators/$COLLAB" -f permission="$PERMISSION" >/dev/null
echo "✓ https://github.com/$FULL  ($VISIBILITY)"
echo "✓ Invited $COLLAB with '$PERMISSION' access. They need to accept the email / github.com/notifications invite."
