#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  shift
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${PROJECT_ROOT}/package.json','utf8')).version)")

PLATFORMS=("darwin-arm64" "darwin-x64" "linux-x64" "linux-arm64")

cd "$PROJECT_ROOT"

# Patch version into platform package.json files
for platform in "${PLATFORMS[@]}"; do
  file="npm/${platform}/package.json"
  echo "Patching version ${VERSION} into ${file}"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$file', 'utf8'));
    p.version = '$VERSION';
    fs.writeFileSync('$file', JSON.stringify(p, null, 2) + '\n');
  "
done

# Patch version into main package.json (version + optionalDependencies)
file="npm/pkglab/package.json"
echo "Patching version ${VERSION} into ${file} (version + optionalDependencies)"
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('$file', 'utf8'));
  p.version = '$VERSION';
  for (const k of Object.keys(p.optionalDependencies || {})) p.optionalDependencies[k] = '$VERSION';
  fs.writeFileSync('$file', JSON.stringify(p, null, 2) + '\n');
"

# Publish platform packages first
for platform in "${PLATFORMS[@]}"; do
  echo "Publishing pkglab-${platform}@${VERSION}..."
  npm publish "npm/${platform}/" --access public $DRY_RUN
done

# Publish main package last
echo "Publishing pkglab@${VERSION}..."
npm publish "npm/pkglab/" --access public $DRY_RUN

echo "Successfully published all packages at version ${VERSION}${DRY_RUN:+ (dry run)}"
