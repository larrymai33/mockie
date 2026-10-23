FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @mockie/runner --include-workspace-root --ignore-scripts
COPY apps/runner/tsconfig.json apps/runner/tsconfig.json
COPY apps/runner/src apps/runner/src
RUN npm run build -w @mockie/runner

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /queue && chown 0:10001 /queue && chmod 770 /queue
WORKDIR /app
COPY --from=build /build/node_modules/zod ./node_modules/zod
COPY --from=build /build/apps/runner/dist ./dist
COPY apps/runner/scripts/linux-integration.mjs ./scripts/linux-integration.mjs
ENV NODE_ENV=production RUNNER_QUEUE_DIR=/queue
# Only the supervisor is root. Compose drops ALL capabilities and adds SETUID,
# SETGID and KILL solely to change child identity and kill its process group.
# setpriv clears supplementary groups and inherited/ambient capabilities and
# sets uid/gid; Linux setuid clears effective/permitted capabilities.
# no-new-privileges prevents child executables regaining capabilities.
USER 0:10001
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "dist/index.js", "healthcheck"]
CMD ["node", "dist/index.js"]
