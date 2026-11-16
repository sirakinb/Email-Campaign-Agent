FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.9 /uv /usr/local/bin/uv
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY pipelines ./pipelines
RUN pnpm install --frozen-lockfile && pnpm build && uv sync --project pipelines --frozen
ENV NODE_ENV=production
ENV UV_OFFLINE=1
CMD ["pnpm", "start"]
