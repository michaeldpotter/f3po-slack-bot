#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-f3data}"
REPO_DIR="${F3PO_REPO_DIR:-/mnt/nas/node/f3po-slack-bot}"
REPO_FILE="/etc/yum.repos.d/google-cloud-sdk.repo"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
else
  echo "Unable to read /etc/os-release. This script is intended for RHEL-compatible systems." >&2
  exit 1
fi

if [[ "${ID:-}" != "rhel" && "${ID_LIKE:-}" != *"rhel"* && "${ID_LIKE:-}" != *"fedora"* ]]; then
  echo "Warning: this script is intended for RHEL-compatible systems. Detected ID=${ID:-unknown} ID_LIKE=${ID_LIKE:-unknown}." >&2
fi

major_version="${VERSION_ID%%.*}"
if [[ "$major_version" == "10" ]]; then
  repo_baseurl="https://packages.cloud.google.com/yum/repos/cloud-sdk-el10-x86_64"
  repo_gpgkey="https://packages.cloud.google.com/yum/doc/rpm-package-key-v10.gpg"
else
  repo_baseurl="https://packages.cloud.google.com/yum/repos/cloud-sdk-el9-x86_64"
  repo_gpgkey="https://packages.cloud.google.com/yum/doc/rpm-package-key.gpg"
fi

echo "Configuring Google Cloud CLI yum repo for ${ID:-rhel} ${VERSION_ID:-unknown}..."
sudo tee "$REPO_FILE" >/dev/null <<EOF
[google-cloud-cli]
name=Google Cloud CLI
baseurl=$repo_baseurl
enabled=1
gpgcheck=1
repo_gpgcheck=0
gpgkey=$repo_gpgkey
EOF

echo "Installing Google Cloud CLI dependencies..."
sudo dnf install -y libxcrypt-compat.x86_64 google-cloud-cli

echo "Installed versions:"
gcloud --version
bq version

echo
echo "Next, authenticate Application Default Credentials for the account that can read BigQuery:"
echo "  gcloud auth application-default login"
echo
echo "Then set the project:"
echo "  gcloud config set project $PROJECT_ID"
echo
echo "After auth, test from the repo:"
echo "  cd $REPO_DIR"
echo "  npm run backblasts:bigquery:dry-run"
echo

read -r -p "Run interactive gcloud auth now? [y/N] " run_auth
if [[ "$run_auth" =~ ^[Yy]$ ]]; then
  gcloud auth application-default login
  gcloud config set project "$PROJECT_ID"

  if [[ -d "$REPO_DIR" ]]; then
    echo "Running BigQuery dry run from $REPO_DIR..."
    (cd "$REPO_DIR" && npm run backblasts:bigquery:dry-run)
  else
    echo "Repo directory not found: $REPO_DIR"
  fi
fi
