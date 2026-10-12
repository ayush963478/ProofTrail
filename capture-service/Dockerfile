# ProofTrail capture service — containerised headless Chromium (blueprint §4/§5:
# "Containerised headless Chromium on Fargate").
#
# Build:  docker build -t prooftrail-capture .
# Run:    docker run --rm -e MODE=fargate -e CAPTURE_ID=... (env table in README)
#
# Uses Debian's Chromium so `npm install` stays small (no ~150 MB download).

FROM node:20-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROMIUM_NO_SANDBOX=1 \
    NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

RUN useradd -m capture && chown -R capture:capture /app
USER capture

ENTRYPOINT ["node", "src/index.js"]
