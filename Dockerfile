FROM --platform=$BUILDPLATFORM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS dependencies
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

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
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
