FROM m.daocloud.io/docker.io/library/node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY data/config.example.json ./data/config.example.json

RUN mkdir -p /app/data /app/logs

EXPOSE 3000 3100

CMD ["npm", "run", "dev"]
