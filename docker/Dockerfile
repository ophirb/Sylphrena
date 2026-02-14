FROM node:18-slim

# Install Chrome dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxss1 libxtst6 \
    wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Set up app directory owned by node user from the start
WORKDIR /usr/src/app
RUN chown node:node /usr/src/app
USER node

# Skip Puppeteer's bundled Chrome download (we install it explicitly below)
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_CACHE_DIR=/usr/src/app/.puppeteer_cache

# Install dependencies
COPY --chown=node:node package*.json ./
RUN npm install --frozen-lockfile --omit=dev

# Download Chrome explicitly
RUN npx puppeteer browsers install chrome

# Copy application code (include package.json to guard against stale layer cache)
COPY --chown=node:node listener.js processor.js shared.js mashov.js notify.js entrypoint.sh package.json ./
RUN chmod +x ./entrypoint.sh

ENTRYPOINT [ "./entrypoint.sh" ]
