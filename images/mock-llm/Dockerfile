# Mock OpenAI-compatible LLM for the clustered e2e (M2/M3).
FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs .
EXPOSE 8080
CMD ["node", "server.mjs"]
