# Actor image: Node + the pinned Pi release + the RPC bridge.
#
# Pi is installed globally at the version this repository declares in
# package.json (`piVersion`). Upgrade both together; the RPC contract the
# bridge depends on is documented in src/protocol/rpc.ts.
FROM node:22-bookworm-slim

ARG PI_VERSION=0.84.2
RUN npm install --global --no-fund --no-audit @earendil-works/pi-coding-agent@${PI_VERSION}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY dist ./dist

# The bridge answers /healthz on the same port it serves the WebSocket, which
# is also the ActorTemplate wakeupProbe.
# Absolute paths everywhere: a substrate actor starts the container without
# the image's WORKDIR, so a relative entry point would not resolve.
ENV PI_BRIDGE_PORT=80 \
    PI_CODING_AGENT_DIR=/workspace/.pi \
    PI_SESSION_DIR=/workspace/.pi/sessions \
    PI_BRIDGE_CWD=/workspace \
    NODE_ENV=production

EXPOSE 80
CMD ["node", "/app/dist/src/bridge/main.js"]
