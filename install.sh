#!/bin/sh
# Bullpen installer.
#
#   curl -fsSL https://raw.githubusercontent.com/BrownJ3/bullpen/main/install.sh | sh
#
# What it does: makes sure Node 24+ is available (installs a private copy in ~/.bullpen/node if not), downloads
# Bullpen to ~/.bullpen/app at the latest release, installs its dependencies, sets it to start at login with a
# `bullpen` command and a Bullpen app, and opens it. Run it again any time; it updates in place.
#
# Options (environment variables):
#   BULLPEN_DIR=...        where to put the app (default ~/.bullpen/app)
#   BULLPEN_REPO=...       git URL to install from (default https://github.com/BrownJ3/bullpen.git)
#   BULLPEN_REF=...        branch or tag to install (default: the newest release tag, else the default branch)
#   BULLPEN_NO_SERVICE=1 don't set up start-at-login or open the UI (for testing)

set -eu

REPO="${BULLPEN_REPO:-https://github.com/BrownJ3/bullpen.git}"
DATA="${BULLPEN_HOME:-$HOME/.bullpen}"
DIR="${BULLPEN_DIR:-$DATA/app}"
NODE_DIR="$DATA/node"
NODE_MAJOR=24

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

bold "Installing Bullpen"

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) die "On Windows, install from PowerShell instead:  irm https://raw.githubusercontent.com/BrownJ3/bullpen/main/install.ps1 | iex" ;;
  *) die "Bullpen runs on macOS, Linux and Windows." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) die "Unsupported processor: $(uname -m)" ;;
esac

command -v git >/dev/null 2>&1 || {
  [ "$OS" = darwin ] && die "git is missing. Run: xcode-select --install   (then run this again)"
  die "git is missing. Install it with your package manager, then run this again."
}

# ---------------------------------------------------------------- Node 24+
node_ok() { "$1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $NODE_MAJOR ? 0 : 1)" 2>/dev/null; }
NODE=""
if [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
  NODE="$NODE_DIR/bin/node"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
fi
if [ -z "$NODE" ]; then
  info "Node $NODE_MAJOR isn't installed; getting a private copy for Bullpen (in $NODE_DIR)..."
  command -v curl >/dev/null 2>&1 || die "curl is missing."
  BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -o "node-v[0-9.]*-$OS-$ARCH.tar.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$FILE" ] || die "No Node $NODE_MAJOR build for $OS-$ARCH."
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  # Check the download against nodejs.org's published checksum.
  WANT="$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
  if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)"; else GOT="$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)"; fi
  [ "$WANT" = "$GOT" ] || die "The Node download didn't match its checksum; try again."
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$FILE" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
  NODE="$NODE_DIR/bin/node"
  info "Node $("$NODE" -v) ready."
fi
NODE_BIN="$(dirname "$NODE")"
PATH="$NODE_BIN:$PATH"
export PATH

# ---------------------------------------------------------------- the app
clone() {
  # Private repos: plain HTTPS (works if git already has a GitHub sign-in), then SSH (works with an SSH key on
  # GitHub), then the GitHub CLI if it's signed in, then HTTPS again letting git ask for a username and token.
  if GIT_TERMINAL_PROMPT=0 git clone --quiet "$REPO" "$1" 2>/dev/null; then return 0; fi
  slug="$(printf '%s' "$REPO" | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')"
  case "$REPO" in
    https://github.com/*)
      if GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10" \
        git clone --quiet "git@github.com:$slug.git" "$1" 2>/dev/null; then
        info "Downloaded over SSH."
        return 0
      fi ;;
  esac
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "$slug" "$1" -- --quiet && return 0
  fi
  if (exec </dev/tty) 2>/dev/null; then
    info "GitHub needs you to sign in. Username: your GitHub username. Password: a personal access token"
    info "(github.com/settings/tokens, with read access to $slug), not your GitHub password."
    git clone --quiet "$REPO" "$1" </dev/tty && return 0
  fi
  die "Couldn't download $REPO. If it's private, ask for access, then do one of these and run this again:
  - sign in with the GitHub CLI:  brew install gh && gh auth login
  - or add an SSH key to GitHub:   https://github.com/settings/keys
  - or clone it yourself and run the installer from it:
      git clone $REPO $DIR && sh $DIR/install.sh"
}

if [ -d "$DIR/.git" ]; then
  info "Updating ${DIR}..."
  git -C "$DIR" fetch --quiet --tags origin
else
  mkdir -p "$(dirname "$DIR")"
  info "Downloading Bullpen to ${DIR}..."
  clone "$DIR"
fi

REF="${BULLPEN_REF:-}"
if [ -z "$REF" ]; then
  REF="$(git -C "$DIR" tag --list 'v[0-9]*' --sort=-v:refname | head -1)"
fi
if [ -n "$REF" ]; then
  git -C "$DIR" checkout --quiet "$REF" 2>/dev/null || git -C "$DIR" checkout --quiet -B "$REF" "origin/$REF"
  # A branch follows its remote; a tag stays put.
  if git -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then git -C "$DIR" reset --quiet --hard "origin/$REF"; fi
else
  git -C "$DIR" pull --quiet --ff-only
fi
info "Version $(git -C "$DIR" describe --tags --always)"

info "Installing dependencies..."
(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error) || die "npm install failed (see above). On a Mac without Apple's command-line tools, run: xcode-select --install"

# ---------------------------------------------------------------- engines
HAVE=""
for c in claude codex; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$HOME/.local/bin/$c" ]; then HAVE="$HAVE $c"; fi
done
[ -d "$HOME/.t3/tools/codex" ] && HAVE="$HAVE codex(T3)"

# ---------------------------------------------------------------- service, command, app
if [ -n "${BULLPEN_NO_SERVICE:-}" ]; then
  bold "Installed (no service, as asked)."
  info "Run it with: $NODE $DIR/src/cli.ts"
else
  "$NODE" "$DIR/src/cli.ts" install
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) info "Add ~/.local/bin to your PATH to use \`bullpen\` from a terminal." ;; esac
  "$NODE" "$DIR/src/cli.ts" open || true
fi

echo
if [ -z "$HAVE" ]; then
  bold "One more step: Bullpen drives Claude Code or Codex, and neither is installed."
  info "Claude Code:  curl -fsSL https://claude.ai/install.sh | bash   then run \`claude\` once to sign in"
  info "Codex:        npm i -g @openai/codex                          then run \`codex login\`"
else
  info "Found:$HAVE. Bullpen uses their existing sign-ins."
fi
info "Update later with: bullpen update"
