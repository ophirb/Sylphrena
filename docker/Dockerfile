# Use an official Node.js 18 runtime as a parent image.
FROM node:18-slim

# Puppeteer requires additional system dependencies to run the headless browser.
# This command installs a common set of libraries needed for Chrome.
RUN apt-get update \
    && apt-get install -y \
    gconf-service \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install --frozen-lockfile --omit=dev

# Create a shared cache directory for Puppeteer and set permissions
ENV PUPPETEER_CACHE_DIR=/usr/src/app/.puppeteer_cache

# Download the version of Chrome that is compatible with the installed Puppeteer
RUN npx puppeteer browsers install chrome

# Copy application source code and the entrypoint script
COPY listener.js processor.js shared.js ./
COPY entrypoint.sh .
RUN chmod +x ./entrypoint.sh

# Set ownership of the entire app directory to the node user.
# This includes node_modules, the puppeteer cache, and the source code.
RUN chown -R node:node /usr/src/app

# Switch to a non-root user for better security
USER node

# Use an entrypoint to select the mode based on the BOT_MODE env var
ENTRYPOINT [ "./entrypoint.sh" ]