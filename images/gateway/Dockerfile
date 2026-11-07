# Gateway image: the always-on Pi gateway plus the kubectl-ate CLI it uses to
# manage actors. bin/kubectl-ate is filled by scripts/deploy-local.sh from the
# kubectl-ate on PATH, so the image matches the installed substrate release.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY dist ./dist
COPY bin/kubectl-ate /usr/local/bin/kubectl-ate
RUN chmod 0755 /usr/local/bin/kubectl-ate

ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "/app/dist/src/gateway/main.js"]
