#!/usr/bin/env sh
# Installs silky from a local git checkout (or clones the repo first if no
# path is given), installs dependencies, and links the `silky` binary into
# ~/.local/bin.
#
# Usage:
#   ./install-git.sh              # clone the repo to ~/.local/share/silky-src
#   ./install-git.sh /path/to/repo
#
# Environment overrides: SILKY_PREFIX, SILKY_BIN, SILKY_SRC (clone target).
set -eu

REPO="https://github.com/alireza-hariri/silkyprojects"
SRC="${SILKY_SRC:-$HOME/.local/share/silky-src}"
PREFIX="${SILKY_PREFIX:-$HOME/.local/share/silky}"
BINDIR="${SILKY_BIN:-$HOME/.local/bin}"

command -v git >/dev/null 2>&1 || { echo "git is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node >= 22.20.0 is required (https://nodejs.org)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required"; exit 1; }

want=2220000
have=$(node -p 'const [a,b,c]=process.versions.node.split(".").map(Number);a*1000000+b*1000+c')
[ "$have" -ge "$want" ] || { echo "node >= 22.20.0 is required (found $(node -v))"; exit 1; }

if [ "$#" -ge 1 ]; then
  src="$1"
else
  if [ -d "$SRC/.git" ]; then
    echo "Updating existing clone at $SRC ..."
    git -C "$SRC" pull --ff-only
    src="$SRC"
  else
    echo "Cloning $REPO to $SRC ..."
    git clone --depth 1 "$REPO" "$SRC"
    src="$SRC"
  fi
fi

[ -f "$src/package.json" ] && [ -f "$src/bin/silky" ] || {
  echo "error: $src does not look like a silky checkout" >&2
  exit 1
}

mkdir -p "$PREFIX" "$BINDIR"
echo "Installing to $PREFIX ..."
# Copy the checkout, skipping git metadata and development files.
mkdir -p "$PREFIX/bin" "$PREFIX/src"
cp "$src/package.json" "$src/package-lock.json" "$src/tsconfig.json" "$src/README.md" "$PREFIX/" 2>/dev/null || true
cp -r "$src/bin/." "$PREFIX/bin/"
cp -r "$src/src/." "$PREFIX/src/"

echo "Installing dependencies ..."
(cd "$PREFIX" && npm install --omit=dev --no-fund --no-audit)

ln -sfn "$PREFIX/bin/silky" "$BINDIR/silky"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "Note: $BINDIR is not on your PATH; add it to your shell profile." ;;
esac

echo "Done. Run: $BINDIR/silky daemon"
