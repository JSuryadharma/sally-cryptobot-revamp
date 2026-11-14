# Production image for a self-hosted server (VPS). See docs/DEPLOY-SERVER.md.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY api ./api
# The dashboard's "Run backtest" button imports these two.
COPY scripts ./scripts
COPY .claude/skills/backtest-expert/scripts ./.claude/skills/backtest-expert/scripts

USER node
EXPOSE 3300
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3300}/api/health" >/dev/null || exit 1

CMD ["node", "src/server.js"]
