FROM node:22

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts \
 && node -e "const lock=require('./package-lock.json'); const deps=new Set(); for (const pkg of Object.values(lock.packages||{})) { for (const [name, version] of Object.entries(pkg.optionalDependencies||{})) { if (/linux-arm64(?:-gnu)?$/.test(name)) deps.add(name + '@' + version); } } console.log([...deps].sort().join('\n'));" > /tmp/linux-arm64-native-deps.txt \
 && if [ -s /tmp/linux-arm64-native-deps.txt ]; then npm install --no-save $(tr '\n' ' ' < /tmp/linux-arm64-native-deps.txt); fi \
 && npm run postinstall

COPY . .
RUN npm run build

CMD ["npm", "run", "start"]
