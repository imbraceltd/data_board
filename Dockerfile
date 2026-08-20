FROM node:20 as base

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@9.0 --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile --prod

FROM base AS builder
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# swc compiles .ts only — the migration .sql files and meta/_journal.json are
# not emitted to dist. swc preserves the src/ prefix, so the compiled runner is
# at dist/src/db/drizzle/migrate.js; copy the migrations next to it so
# runMigrations() resolves them via __dirname/migrations at boot.
COPY --from=builder /app/src/db/drizzle/migrations ./dist/src/db/drizzle/migrations
# Same swc caveat for the default Document Model JSON files (DocIQ cold-start
# seed): swc does not emit *.json, so copy them next to the compiled loader at
# dist/src/core/services/default-doc-schemas/ where loadDefaultDocModels()
# resolves them via __dirname at boot. Adding/removing a default model is then a
# pure JSON change — this COPY needs no edit.
COPY --from=builder /app/src/core/services/default-doc-schemas ./dist/src/core/services/default-doc-schemas

EXPOSE 8081
CMD ["node", "dist/src/index.js"]
