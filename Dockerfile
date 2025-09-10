FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

ENV PORT=3000
EXPOSE 3000

CMD ["node","dist/server.js"]


