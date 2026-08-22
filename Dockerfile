FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS bun-release

FROM dhi.io/bun:1-alpine-dev@sha256:d364f4eb6d20f8e906bdb9d12726995f8335878f46e0c1c69c910df9d92df5d8 AS deps
WORKDIR /app

COPY --from=bun-release /usr/local/bin/bun /usr/local/bin/bun
RUN bun -e 'if (Bun.version !== "1.4.0" || Bun.revision !== "34cbb9a40b4bd1bd767d134a7065e66c2432a676") throw new Error("Bun image requires 1.4.0+34cbb9a40, got " + Bun.version + "+" + Bun.revision.slice(0, 9))'

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY tools/socket-security-scanner.ts ./tools/socket-security-scanner.ts
RUN unset SOCKET_API_TOKEN SOCKET_API_KEY; \
  unset BUN_CONFIG_SKIP_LOAD_LOCKFILE BUN_FEATURE_FLAG_DISABLE_IGNORE_SCRIPTS BUN_CONFIG_REGISTRY NPM_CONFIG_REGISTRY; \
  if ! install_output="$(bun ci --no-env-file --ignore-scripts --registry=https://registry.npmjs.org 2>&1)"; then printf '%s\n' "$install_output"; exit 1; fi; \
  printf '%s\n' "$install_output"; \
  if ! printf '%s\n' "$install_output" | grep -Fq 'Socket Security Scanner free mode'; then echo 'Container dependency installation must remain credential-free.' >&2; exit 1; fi

FROM deps AS build
COPY Dockerfile ./
COPY public ./public
COPY src ./src
COPY test ./test
COPY tools ./tools
RUN /usr/local/bin/bun --no-env-file --no-orphans \
  /app/tools/platform-verify.ts /app

FROM dhi.io/bun:1-alpine@sha256:b169efde3cf30151d66f3d7988cad69b4d08833cc4cfaeca7da6bda2bd0a89b3 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV PUBLIC_DIR=/app/dist/public

COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /app/dist ./dist
RUN ["bun", "-e", "if (Bun.version !== \"1.4.0\" || Bun.revision !== \"34cbb9a40b4bd1bd767d134a7065e66c2432a676\") throw new Error(\"Bun image requires 1.4.0+34cbb9a40, got \" + Bun.version + \"+\" + Bun.revision.slice(0, 9))"]

EXPOSE 8080
CMD ["bun", "dist/server.js"]
