FROM ghcr.io/puppeteer/puppeteer:21.6.0

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Expose port
EXPOSE 3000

# Run the application
CMD ["node", "index.js"]
