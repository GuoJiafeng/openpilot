#!/bin/bash
# FRP client launcher — downloads frpc if missing, then tunnels C3 web to frps.
BIN=/data/openpilot/tools/frpc
CFG=/data/openpilot/selfdrive/c3_web/frpc.toml
FRPC_VER=0.61.2
FRPC_URL="https://github.com/fatedier/frp/releases/download/v${FRPC_VER}/frp_${FRPC_VER}_linux_arm64.tar.gz"

if [ ! -f "$BIN" ]; then
  echo "frpc not found, downloading v${FRPC_VER} ..."
  curl -sL -o /tmp/frpc.tar.gz "$FRPC_URL"
  cd /tmp && tar xzf frpc.tar.gz
  cp "frp_${FRPC_VER}_linux_arm64/frpc" "$BIN"
  chmod +x "$BIN"
  rm -rf /tmp/frpc.tar.gz "/tmp/frp_${FRPC_VER}_linux_arm64"
fi

exec "$BIN" -c "$CFG"
