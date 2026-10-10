FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev

COPY server/src ./server/src
ENV NODE_ENV=production PORT=5000
EXPOSE 5000
CMD ["node", "server/src/server.js"]
