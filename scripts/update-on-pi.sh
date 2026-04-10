#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/pi/webdmx}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-webdmx}"

echo "Updating CuteLight in ${APP_DIR} from branch ${BRANCH}"
cd "${APP_DIR}"

if [[ ! -d .git ]]; then
  echo "Error: ${APP_DIR} is not a git repository." >&2
  exit 1
fi

git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"

npm ci --omit=dev

sudo systemctl restart "${SERVICE_NAME}"
sleep 1
sudo systemctl --no-pager --full status "${SERVICE_NAME}" -n 30

echo "Update complete."
