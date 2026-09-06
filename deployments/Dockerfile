FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/agent/package.json ./apps/agent/package.json
COPY apps/maintenance/package.json ./apps/maintenance/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/application-spec/package.json ./packages/application-spec/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/providers/package.json ./packages/providers/package.json
RUN npm ci
COPY apps ./apps
COPY packages ./packages
COPY tsconfig*.json ./
ENV API_URL=http://api:3001 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS api
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/database/prisma ./packages/database/prisma
COPY package.json ./
USER 10001:10001
ENV NODE_ENV=production HOST=0.0.0.0
CMD ["node","dist/apps/api/src/main.js"]

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS agent
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && apt-get update && apt-get install -y --no-install-recommends git util-linux docker-ce-cli docker-buildx-plugin docker-compose-plugin && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV NODE_ENV=production
CMD ["node","dist/apps/agent/src/main.js"]

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS web
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/apps/web/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/apps/web/.next/static ./apps/web/.next/static
USER 10001:10001
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
CMD ["node","apps/web/server.js"]

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS maintenance
WORKDIR /app
COPY --from=build /app/dist/apps/maintenance/src/main.js /app/main.mjs
USER 10001:10001
CMD ["node","/app/main.mjs"]
