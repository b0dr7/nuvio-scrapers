#!/usr/bin/env bash
# warp-setup.sh - run cloudflare warp on this machine and expose it as a local
# proxy so nuvio (or anything else on the network) can reach domains your dns
# or isp blocks.
#
# what it does:
#   1. downloads wgcf (unofficial cloudflare warp account tool) and wireproxy
#      (wireguard client that speaks socks5/http)
#   2. registers a free warp account and generates a wireguard profile
#   3. starts wireproxy exposing:
#        socks5://0.0.0.0:40000
#        http://0.0.0.0:40001
#
# usage:
#   chmod +x tools/warp/warp-setup.sh
#   sudo ./tools/warp/warp-setup.sh
#
# test it:
#   curl -x socks5://127.0.0.1:40000 https://hydrahd.info
#   curl -x http://127.0.0.1:40001 https://laroza.to
#
# then point your device at this machine's lan ip, port 40000 (socks5) or
# 40001 (http), or run the script on your router / a box on the same lan.
# if the block is dns-level only, you don't need any of this: switch the
# device to 1.1.1.1 or 8.8.8.8 and the domain will resolve again.

set -euo pipefail

WORKDIR="${WARP_DIR:-$HOME/.warp-proxy}"
SOCKS_PORT="${WARP_SOCKS_PORT:-40000}"
HTTP_PORT="${WARP_HTTP_PORT:-40001}"
ARCH="$(uname -m)"

log() { printf '[warp] %s\n' "$*"; }
die() { printf '[warp] error: %s\n' "$*" >&2; exit 1; }

case "$ARCH" in
  x86_64|amd64)  WGCF_ARCH="x86_64";  WIRE_ARCH="amd64" ;;
  aarch64|arm64) WGCF_ARCH="arm64";   WIRE_ARCH="arm64" ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

command -v curl >/dev/null || die "curl is required"
command -v unzip >/dev/null || die "unzip is required"

mkdir -p "$WORKDIR"
cd "$WORKDIR"

latest_asset() {
  # $1 = repo, $2 = regex the asset name must match
  curl -fsSL "https://api.github.com/repos/$1/releases/latest" \
    | grep -oE '"browser_download_url": *"[^"]+"' \
    | cut -d'"' -f4 \
    | grep -E "$2" \
    | head -n1
}

if [ ! -x ./wgcf ]; then
  log "downloading wgcf"
  url="$(latest_asset "ViRb3/wgcf" "wgcf_.*Linux_${WGCF_ARCH}\\.zip$")"
  [ -n "$url" ] || die "could not resolve wgcf download url"
  curl -fsSL -o wgcf.zip "$url"
  unzip -o -q wgcf.zip wgcf
  chmod +x wgcf
fi

if [ ! -x ./wireproxy ]; then
  log "downloading wireproxy"
  url="$(latest_asset "pufferffish/wireproxy" "wireproxy_.*linux_${WIRE_ARCH}\\.(zip|tar\\.gz)$")"
  [ -n "$url" ] || die "could not resolve wireproxy download url"
  case "$url" in
    *.zip)
      curl -fsSL -o wireproxy.zip "$url"
      unzip -o -q wireproxy.zip wireproxy || unzip -o -q wireproxy.zip
      ;;
    *.tar.gz)
      curl -fsSL -o wireproxy.tar.gz "$url"
      tar -xzf wireproxy.tar.gz
      ;;
  esac
  find . -maxdepth 2 -type f -name 'wireproxy*' -exec mv {} ./wireproxy \; 2>/dev/null || true
  chmod +x wireproxy
fi

if [ ! -f wgcf-account.toml ]; then
  log "registering warp account"
  ./wgcf register --accept-tos
fi

if [ ! -f wgcf-profile.conf ]; then
  log "generating wireguard profile"
  ./wgcf generate
fi

if pgrep -f 'wireproxy -c wgcf-profile.conf' >/dev/null 2>&1; then
  log "wireproxy already running"
else
  log "starting wireproxy on socks5:$SOCKS_PORT and http:$HTTP_PORT"
  nohup ./wireproxy -c wgcf-profile.conf \
    -proxy "socks5://0.0.0.0:${SOCKS_PORT}" \
    -proxy "http://0.0.0.0:${HTTP_PORT}" \
    > wireproxy.log 2>&1 &
  sleep 2
  pgrep -f 'wireproxy -c wgcf-profile.conf' >/dev/null 2>&1 \
    || die "wireproxy failed to start, check $WORKDIR/wireproxy.log"
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
log "done."
log "local test : curl -x socks5://127.0.0.1:${SOCKS_PORT} https://hydrahd.info"
log "lan address: ${LAN_IP:-<this machine>}  (socks5 port ${SOCKS_PORT}, http port ${HTTP_PORT})"
log "stop it    : pkill -f 'wireproxy -c wgcf-profile.conf'"
