FROM golang:1.27-bookworm AS atecli

ARG SUBSTRATE_COMMIT=bce845180740e07cf08b63060ebeead8de3204cc

RUN git init /src \
    && cd /src \
    && git remote add origin https://github.com/agent-substrate/substrate.git \
    && git fetch --depth=1 origin "${SUBSTRATE_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
       go build -o /out/kubectl-ate ./cmd/kubectl-ate

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=atecli /out/kubectl-ate /usr/local/bin/kubectl-ate

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY dist ./dist

ENV NODE_ENV=production \
    PI_HTTP_HOST=0.0.0.0 \
    PI_HTTP_PORT=8788 \
    PI_GATEWAY_DATA_DIR=/data \
    PI_ACTOR_URL=ws://atenet-router.ate-system.svc:80

EXPOSE 8788
CMD ["node", "/app/dist/src/host/main.js"]
