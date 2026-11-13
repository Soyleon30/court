ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-alpine
FROM ${NODE_BASE_IMAGE}

WORKDIR /app

COPY package.json ./
RUN npm config set registry https://registry.npmmirror.com \
 && npm install --omit=dev --no-audit --no-fund

COPY app.js index.html styles.css server.js schema.sql ./

ENV NODE_ENV=production PORT=4173
EXPOSE 4173

CMD ["node", "server.js"]
