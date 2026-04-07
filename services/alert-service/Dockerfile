FROM node:22

WORKDIR /app

COPY package*.json ./
COPY package-lock.json ./
RUN npm ci

COPY src ./src
COPY tsconfig.json ./

RUN if [ ! -s tsconfig.json ]; then echo "Error: tsconfig.json is empty or missing"; exit 1; fi && \
    npm install -g typescript && \
    tsc --diagnostics || { echo "TypeScript compilation failed"; exit 1; }

CMD ["node", "dist/index.js"]
