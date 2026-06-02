#!/usr/bin/env bash
# Build a release of krill-audio-editor and gather artifacts under release/v<version>/.
#
# What this does:
#   1. Reads the version from package.json.
#   2. Runs `tauri build` (release profile) which produces AppImage + .deb.
#   3. Copies those artifacts into release/v<version>/ alongside SHA256 checksums.
#
# What this does NOT do:
#   - Commit, tag, or push to git. Those are explicit operations, run them by hand.
#   - Upload to any remote.
#
# Flags:
#   --skip-build   Skip `tauri build`; just regather existing artifacts.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

VERSION=$(node -e 'console.log(require("./package.json").version)')
if [[ -z "$VERSION" ]]; then
  echo "could not read version from package.json" >&2
  exit 1
fi

echo "==> Releasing krill-audio-editor v$VERSION"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Installing dependencies"
  pnpm install --frozen-lockfile

  echo "==> Building release artifacts"
  pnpm tauri build
fi

OUT="$ROOT/release/v$VERSION"
mkdir -p "$OUT"

BUNDLE="$ROOT/src-tauri/target/release/bundle"
shopt -s nullglob

APPIMAGE=("$BUNDLE"/appimage/*.AppImage)
DEB=("$BUNDLE"/deb/*.deb)
RPM=("$BUNDLE"/rpm/*.rpm)

if [[ ${#APPIMAGE[@]} -eq 0 && ${#DEB[@]} -eq 0 && ${#RPM[@]} -eq 0 ]]; then
  echo "no bundles found under $BUNDLE — did the build succeed?" >&2
  exit 1
fi

for f in "${APPIMAGE[@]}" "${DEB[@]}" "${RPM[@]}"; do
  cp -v "$f" "$OUT/"
done

(cd "$OUT" && sha256sum --tag * | tee SHA256SUMS)

echo
echo "==> Artifacts written to $OUT"
ls -lh "$OUT"
