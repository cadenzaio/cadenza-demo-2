FROM node:22

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY package-lock.json ./

# Install dependencies including TypeScript
RUN npm ci

# Copy source code and tsconfig
COPY src ./src
COPY tsconfig.json ./

# Verify tsconfig.json and compile TypeScript to JavaScript
RUN if [ ! -s tsconfig.json ]; then echo "Error: tsconfig.json is empty or missing"; exit 1; fi && \
    npm install -g typescript && \
    tsc --diagnostics || { echo "TypeScript compilation failed"; exit 1; }

# Start the service
CMD ["node", "dist/index.js"]