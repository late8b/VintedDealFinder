#!/bin/bash
# Ensures curl is available and optionally downloads curl-impersonate-chrome
# This is run during the Render build step

BIN_DIR="$(dirname "$0")/bin"
mkdir -p "$BIN_DIR"

# Ensure curl is installed (Render Node.js images may not have it)
if ! command -v curl &>/dev/null; then
  echo "curl not found, installing..."
  apt-get update -qq && apt-get install -y -qq curl
fi

# Optional: download curl-impersonate-chrome for better Cloudflare bypass
if [ ! -f "$BIN_DIR/curl-impersonate-chrome" ] && [ "$(uname -s)" = "Linux" ]; then
  echo "Downloading curl-impersonate-chrome..."
  VERSION="v0.6.1"
  ARCH="x86_64-linux-gnu"
  TARBALL="curl-impersonate-${VERSION}.${ARCH}.tar.gz"
  URL="https://github.com/lwthiker/curl-impersonate/releases/download/${VERSION}/${TARBALL}"

  cd /tmp
  if curl -sLO "$URL"; then
    tar xzf "$TARBALL" 2>/dev/null
    if [ -f "curl-impersonate-chrome" ]; then
      cp "curl-impersonate-chrome" "$BIN_DIR/"
      chmod +x "$BIN_DIR/curl-impersonate-chrome"
      echo "curl-impersonate-chrome installed"
    else
      echo "Warning: curl-impersonate-chrome binary not found in tarball"
    fi
  else
    echo "Warning: could not download curl-impersonate, will use system curl"
  fi
fi
