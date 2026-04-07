FROM node:22

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.mjs ./

CMD ["npm", "run", "start"]
