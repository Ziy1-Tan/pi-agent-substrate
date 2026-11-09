# Actor image: Node + the pi-durable Harness. There is no pi CLI in the image:
# each turn runs in-process through the Harness (see src/actor/bridge.ts).
#
# Versions are pinned in package.json. Node must be >= 22.19, which pi-durable
# requires; the base image tag below must stay at or above that.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY dist ./dist

# The bridge answers /healthz on the same port it serves the WebSocket.
# Absolute paths everywhere: a substrate actor starts the container without
# the image's WORKDIR, so a relative entry point would not resolve.
ENV PI_BRIDGE_PORT=80 \
    NODE_ENV=production

EXPOSE 80
CMD ["node", "/app/dist/src/actor/main.js"]
