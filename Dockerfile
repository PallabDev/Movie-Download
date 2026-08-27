FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npx tsc

# Remove dev dependencies after build
RUN npm prune --production

# Create required directories
RUN mkdir -p download/movies download/shows bot-session

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
