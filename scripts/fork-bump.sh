#!/usr/bin/env bash
# One display server built from a fork this project keeps (nix/README.md, "Forks"): if the fork has released a newer
# `<upstream tag>-dither.<n>` than nix/<name>.nix builds, copy the release's nix file as it is onto the branch
# fork-bump/<name>, open that fork's one pull request or update it, and start CI on it. Never merges.
# .github/workflows/fork-bump.yml runs it for each fork, daily and by hand.
#
#   NAME=kasmvnc FORK=<owner>/KasmVNC BACKEND=kasmvnc scripts/fork-bump.sh
#
# DRY_RUN=1 fetches and writes nix/<name>.nix in the working tree, then stops: nothing is committed or pushed.
set -euo pipefail
: "${NAME:?}" "${FORK:?}" "${BACKEND:?}"
BRANCH=fork-bump/$NAME
BASE=${BASE:-master}
file=nix/$NAME.nix
tag_of() { sed -n 's/^ *tag = "\(.*\)";$/\1/p' | head -1; }

current=$(tag_of <"$file")
latest=$(gh release list -R "$FORK" --exclude-drafts --exclude-pre-releases --limit 100 --json tagName -q '.[].tagName' |
  grep -E -- '^[A-Za-z0-9][A-Za-z0-9._+-]*-dither\.[0-9]+$' | sort -V | tail -1 || true)
# The pattern keeps out a tag that starts with `-`, which gh and git would read as an option; `--` below as well.
if [ -z "$latest" ]; then
  echo "::error::$FORK has no -dither.N release"
  exit 1
fi
if [ "$latest" = "$current" ] || [ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -1)" != "$latest" ]; then
  echo "$NAME: $current is the newest release ($latest on $FORK)"
  exit 0
fi
echo "$NAME: $current → $latest"

# The bump already open for this release, on the base as it is now: pushing it again would only run CI again.
if [ "${DRY_RUN:-}" != 1 ] && git fetch -q --depth=2 origin "+refs/heads/$BASE:refs/remotes/origin/$BASE" \
  "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>/dev/null &&
  [ "$(git show "origin/$BRANCH:$file" | tag_of)" = "$latest" ] &&
  [ "$(git rev-parse "origin/$BRANCH^")" = "$(git rev-parse "origin/$BASE")" ]; then
  echo "$NAME: fork-bump/$NAME already carries $latest on the current $BASE"
  exit 0
fi

gh release download -R "$FORK" -p "$NAME.nix" -O "$file" --clobber -- "$latest"
if [ "$(tag_of <"$file")" != "$latest" ]; then
  echo "::error::$FORK's $latest release carries a $NAME.nix that does not build $latest"
  exit 1
fi
[ "${DRY_RUN:-}" = 1 ] && { git --no-pager diff --stat; exit 0; }

title="nix: $NAME $latest from its fork"
body="$FORK released \`$latest\` (was \`$current\`): [the release](https://github.com/$FORK/releases/tag/$latest), [what changed](https://github.com/$FORK/compare/$current...$latest).

\`$file\` is the release's own nix file, copied as it is. The fork's CI built and smoke-tested it against the nixpkgs its comment names; this pull request's CI builds it against this repo's pin (nix/pin.json) and runs the \`$BACKEND\` backend's tests with every program required (\`DITHER_TESTS_NEED_ALL\`).

Opened by .github/workflows/fork-bump.yml, which updates this pull request when a newer release comes. It is never merged automatically: merge it by hand once CI is green."

# The branch is made again from the base each time, so it never falls behind; it holds this one commit only.
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git checkout -B "$BRANCH"
git add "$file"
git commit -q -F- <<EOF
$title

$FORK's release $latest, its nix file copied as it is (was $current).
EOF
git push -q --force origin "$BRANCH"

pr=$(gh pr list --head "$BRANCH" --base "$BASE" --state open --json number -q '.[0].number')
if [ -z "$pr" ]; then
  gh pr create --base "$BASE" --head "$BRANCH" --title "$title" --body "$body"
else
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/$pr" -f title="$title" -f body="$body" >/dev/null
  echo "updated #$pr"
fi
# A push made with the workflow's own token starts no workflow, but a dispatch does: CI on the branch's commit, whose
# checks the pull request shows.
gh workflow run ci.yml --ref "$BRANCH"
