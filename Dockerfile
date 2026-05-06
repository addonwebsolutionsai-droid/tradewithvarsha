FROM node:20-alpine AS builder
WORKDIR /app

# Install both server + client dependencies
COPY server/package.json server/package-lock.json* ./server/
COPY client/package.json client/package-lock.json* ./client/
RUN cd server && npm ci --omit=optional
RUN cd client && npm ci

# Copy source and build both
COPY server/ ./server/
COPY client/ ./client/
RUN cd server && npx tsc
RUN cd client && npm run build

# ── Runtime stage ────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy server runtime + built client (served statically if desired)
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/client/dist ./client/dist
COPY .claude ./.claude
RUN mkdir -p ./server/data

# Server reads .env from project root — inject via cloud env vars instead
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
