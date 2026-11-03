#!/usr/bin/env bash
# Pulls main and rebuilds the stack when GitHub has something new. Run every
# five minutes by budget-deploy.timer (infra/README.md "Automatic updates");
# `infra/deploy.sh --force` rebuilds even when nothing changed.
#
# Everything is inside main() so bash has read the whole file before the merge
# below can rewrite it.
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."

  if [ "$(git branch --show-current)" != "main" ]; then
    echo "Not on main ($(git branch --show-current)); not deploying." >&2
    exit 1
  fi

  git fetch --quiet origin main
  local here there
  here=$(git rev-parse HEAD)
  there=$(git rev-parse origin/main)
  if [ "$here" = "$there" ] && [ "${1:-}" != "--force" ]; then
    exit 0
  fi

  echo "Deploying ${there:0:7} (was ${here:0:7})."
  git merge --ff-only --quiet origin/main
  # --build is what makes the new code run; compose runs `migrate` before
  # starting the api, and waits for it to succeed.
  APP_VERSION=$(git rev-parse --short HEAD) docker compose -f infra/docker-compose.yml up -d --build

  # A failed migration leaves the api down; this makes the unit fail, so
  # `systemctl status budget-deploy` says so.
  curl -fsS --retry 10 --retry-connrefused --retry-delay 3 localhost:3001/health
  echo

  # Every build leaves the previous images and build cache behind.
  docker image prune -f >/dev/null
  docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true
}

main "$@"
