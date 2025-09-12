FROM public.ecr.aws/docker/library/node:20-alpine

# Install troubleshooting tools for ECS exec sessions
# - curl: health checks and HTTP debugging
# - bash: interactive shell convenience
# - bind-tools: dig/nslookup
# - iproute2: ip/ss networking tools
# - procps: ps, top, etc
# - jq: JSON parsing
# - tini: minimal init for proper signal handling and zombie reaping
# - netcat-openbsd: nc port checks
RUN apk add --no-cache \
  curl \
  bash \
  bind-tools \
  iproute2 \
  procps \
  jq \
  tini \
  netcat-openbsd

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Container-level health check for ECS/EC2 and local runs
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

# Use tini for correct signal handling in containers
ENTRYPOINT ["/sbin/tini","--"]

CMD ["node","dist/server.js"]


