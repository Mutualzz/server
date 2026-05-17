FROM node:lts AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# Prune the monorepo to only server + its workspace deps
FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @mutualzz/server --docker

# Install only pruned deps
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm build --filter=@mutualzz/server

# Final image
FROM node:lts-slim AS runner
WORKDIR /app/apps/server
COPY --from=builder /app/apps/server/dist ./dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/server/package.json .
CMD ["node", "-r", "dotenv/config", "./dist/bundle/index.mjs"]
