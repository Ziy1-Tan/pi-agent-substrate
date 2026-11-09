# Gateway image: the always-on Pi gateway. It calls ate-api over gRPC with its
# pod certificate, so it carries no kubectl-ate.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY dist ./dist
COPY proto ./proto

ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "/app/dist/src/gateway/main.js"]
