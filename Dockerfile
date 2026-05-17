FROM node:lts AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@latest --activate

FROM base AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ENV NODE_ENV=production
RUN pnpm build:server

FROM base AS deploy
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app

WORKDIR /app/apps/server
EXPOSE 3000 3001 4000
CMD ["pnpm", "start"]
