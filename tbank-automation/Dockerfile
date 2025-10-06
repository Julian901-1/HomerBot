FROM ghcr.io/puppeteer/puppeteer:24.1.0

# Set working directory
WORKDIR /app

# Switch to root to update npm
USER root

# Update npm to latest version
RUN npm install -g npm@11.6.1

# Switch back to pptruser for security
USER pptruser

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application files
COPY . .

# Expose port
EXPOSE 3000

# Run the application
CMD ["node", "index.js"]
