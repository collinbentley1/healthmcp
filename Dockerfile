# syntax=docker/dockerfile:1.7

FROM dhi.io/bun:1-dev@sha256:67209598b7e7db266ae5630f9b27662d3a80b0915615bbcb9f703f562c5b5a52 AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install --no-install-recommends --yes curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.com/install | BUN_INSTALL=/usr/local bash -s "bun-v1.4.0"
RUN bun -e 'if (Bun.version !== "1.4.0") throw new Error("Bun 1.4 native image requires Bun 1.4.0, got " + Bun.version)'

COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun ci

FROM deps AS build
COPY Dockerfile ./
COPY public ./public
COPY src ./src
COPY test ./test
COPY tools ./tools
RUN bun run verify:ci

FROM dhi.io/bun:1@sha256:3f3bcd8aeebefe5a4477ad5cd3a1a0154213c028f63a4d6ea84eeafe5dc69a38 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV PUBLIC_DIR=/app/dist/public

COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
RUN ["bun", "-e", "if (Bun.version !== \"1.4.0\") throw new Error(\"Bun 1.4 native image requires Bun 1.4.0, got \" + Bun.version)"]
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["bun", "dist/server.js"]
