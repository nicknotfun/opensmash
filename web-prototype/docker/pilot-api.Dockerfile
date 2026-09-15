# syntax=docker/dockerfile:1
# Build from the repository root; the default image needs no engine artifacts.
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate
WORKDIR /workspace/web-prototype
COPY web-prototype/package.json web-prototype/pnpm-lock.yaml web-prototype/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
# Imports from the Melee browser package need its package dependencies too.
COPY engines/melee/web/package.json engines/melee/web/package-lock.json /workspace/engines/melee/web/
RUN cd /workspace/engines/melee/web && npm ci --ignore-scripts --no-audit --no-fund
COPY web-prototype/ ./
COPY engines/ssb64/launcher /workspace/engines/ssb64/launcher
COPY engines/melee/launcher /workspace/engines/melee/launcher
COPY engines/melee/web/app /workspace/engines/melee/web/app
COPY engines/melee/web/lib /workspace/engines/melee/web/lib
COPY engines/melee/web/public/catalog.json /workspace/engines/melee/web/public/catalog.json
COPY engines/melee/runtime/launch-options.json /workspace/engines/melee/runtime/launch-options.json
COPY engines/melee/runtime/web/*.mjs /workspace/engines/melee/runtime/web/
RUN pnpm build && test -s dist/ssb64-netplay.js

FROM node:22-bookworm-slim AS site
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 \
    CREATION_ENABLED=0 FIGHTER_WORKER_DISABLED=1 \
    FIGHTER_JOBS_ROOT=/tmp/fighter-jobs OBJECT_STORE_ROOT=/tmp/objects \
    OPENSMASH_ENGINE_ROOT=/workspace/ssb64-runtime \
    OPENSMASH_MELEE_BROWSER_ROOT=/workspace/melee-browser-runtime
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate
WORKDIR /workspace/web-prototype
COPY web-prototype/package.json web-prototype/pnpm-lock.yaml web-prototype/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /workspace/web-prototype/dist ./dist
COPY web-prototype/server ./server
COPY web-prototype/shared ./shared
COPY web-prototype/config ./config
COPY web-prototype/visual ./visual
COPY web-prototype/infra/pilot-site.mjs ./infra/pilot-site.mjs
COPY engines/melee/server /workspace/engines/melee/server
RUN mkdir -p /workspace/play/ui /workspace/ssb64-runtime && chmod -R a+rX /workspace
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]

# Opt in only after producing and verifying the patched engine. The named
# context is a local web-dist directory, never the BattleShip source or ROM.
FROM site AS with-ssb64
COPY --from=ssb64-runtime /index.html /BattleShip.js /BattleShip.wasm /manifest.json /rom-extract.js /torch-worker.js /workspace/ssb64-runtime/
COPY --from=ssb64-runtime /files /workspace/ssb64-runtime/files
COPY --from=ssb64-runtime /torch /workspace/ssb64-runtime/torch
RUN node infra/pilot-site.mjs check-runtime /workspace/ssb64-runtime

# Generic emulator payloads contain no ISO or game-derived executable. The
# named context is already a verified manifest-only package, checked again here.
FROM site AS with-melee-browser
COPY --from=melee-browser-runtime / /workspace/melee-browser-runtime/
RUN node server/melee-browser-runtime.js check /workspace/melee-browser-runtime

# Include both engines explicitly so adding browser Melee retains Smash64.
FROM with-ssb64 AS with-games
COPY --from=melee-browser-runtime / /workspace/melee-browser-runtime/
RUN node server/melee-browser-runtime.js check /workspace/melee-browser-runtime

# Keep this last: an ordinary docker build creates the site-only image.
FROM site AS pilot
