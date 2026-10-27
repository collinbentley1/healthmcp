FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun ci --no-env-file --ignore-scripts --registry=https://registry.npmjs.org

FROM dependencies AS build
COPY . .
RUN bun --no-env-file run verify:ci && mkdir -p /app/.local

FROM dependencies AS production-dependencies
ARG TARGETARCH
ARG TARGETOS
RUN if [ "$TARGETARCH" = "amd64" ]; then target_cpu=x64; else target_cpu="$TARGETARCH"; fi; rm -rf node_modules && bun ci --cpu="$target_cpu" --os="$TARGETOS" --production --no-env-file --ignore-scripts --registry=https://registry.npmjs.org

FROM oven/bun:1.4.2-distroless@sha256:1a0c31c7c5f9d193aedf60fe1cebdeb76ac8f6e29f24be8dd8cbd6df72df26ec
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=production-dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=1000:1000 /app/package.json /app/bun.lock ./
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/.local ./.local
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["--no-env-file", "dist/server.js"]
