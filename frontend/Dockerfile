FROM node:22

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts \
 && npm run postinstall

COPY . .
RUN npm run build

CMD ["npm", "run", "start"]
