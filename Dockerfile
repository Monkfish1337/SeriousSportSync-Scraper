FROM node:24-alpine

WORKDIR /app

# Install only production deps for a slim, reproducible image.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Persistent state lives in /app/data; mount a volume to /app/data to survive
# rebuilds.
ENV DATA_DIR=/app/data
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1

CMD ["node", "server.js"]
