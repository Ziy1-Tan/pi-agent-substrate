# Mock OpenAI-compatible LLM for the clustered end-to-end tests.
FROM node:22-bookworm-slim
WORKDIR /app
# The image carries its own module scope: this directory sits outside the
# repository's package.json, so without one Node would read `server.js` as
# CommonJS and reject its `import`.
COPY package.json server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
