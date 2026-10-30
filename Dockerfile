# ⚡ Memora Browser — Production Docker Image
# Ultra-lightweight, zero-GPU headless browser engine for AI Agents
FROM node:22-alpine

WORKDIR /app

# Install minimal production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy compiled assets
COPY dist/ ./dist/
COPY README.md ./

# Expose CDP & HTTP REST port
EXPOSE 9222

# Health check endpoint
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9222/json/version || exit 1

# Run Memora Browser daemon
ENTRYPOINT ["node", "./dist/cli/index.js"]
# Stealth is on by default (there is no --stealth flag; use --no-stealth to disable it)
CMD ["--port", "9222", "--host", "0.0.0.0"]

