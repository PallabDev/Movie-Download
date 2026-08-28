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

# Create required directories and set permissions
RUN mkdir -p download/movies download/shows bot-session && \
    touch /app/logs.md /app/error.md /app/memory.md /app/movie.md && \
    chmod -R 777 download bot-session && \
    chmod 666 /app/logs.md /app/error.md /app/memory.md /app/movie.md && \
    true

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
