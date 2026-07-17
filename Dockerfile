# Deploy image for the Clio MCP server.
#
# Railway builds from this Dockerfile (it takes precedence over Nixpacks /
# Railpack). We use it specifically to guarantee a Chromium browser is present:
# render_bill_pdf / download_bills_pdf render invoices to PDF with puppeteer-core,
# which ships no browser of its own. The Debian `chromium` package installs the
# binary at /usr/bin/chromium — a path findChromium() already resolves, and we
# also pin PUPPETEER_EXECUTABLE_PATH to it so no detection is needed.
FROM node:22-bookworm-slim

# System Chromium + the fonts it needs for faithful PDF rendering. The render is
# hermetic (all network blocked), so webfonts fall back to these system fonts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# puppeteer-core launches this exact binary; no PATH/store scanning required.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install deps first for better layer caching. Full install (incl. devDeps) is
# required because the build step uses esbuild (a devDependency).
COPY package.json package-lock.json ./
RUN npm ci

# Build the bundle. esbuild externalizes the runtime deps, so node_modules is
# kept in the final image (they are resolved at runtime, not bundled).
COPY . .
RUN npm run build

# Procfile runs `npm start`, which rebuilds before starting; building here and
# running the built bundle directly is faster and avoids a rebuild on boot.
CMD ["node", "dist/index.js"]
