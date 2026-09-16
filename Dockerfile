# Multi-stage build for optimized Docker image
# Stage 1: Build stage
FROM node:20-alpine3.20 AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci

COPY src/ ./src/

RUN npm run build

# Stage 2: Production stage
FROM node:20-alpine3.20 AS production

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

# The server shells out to `docker` to inspect containers and read their logs,
# so the client binary must be present. The daemon itself is the host's, reached
# through the socket mounted at runtime.
RUN apk add --no-cache docker-cli

COPY --from=builder /app/dist ./dist
COPY entrypoint.sh ./entrypoint.sh

RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp -u 1001 && \
    chmod +x ./entrypoint.sh && \
    chown -R mcp:nodejs /app

USER mcp

ENV NODE_ENV=production
ENV MCP_SERVER_NAME=kafka-docker-playground
ENV MCP_SERVER_VERSION=2.0.0

ENTRYPOINT ["./entrypoint.sh"]

CMD ["npm", "start"]
