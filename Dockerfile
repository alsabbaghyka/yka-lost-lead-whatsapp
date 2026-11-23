# Lost Lead WhatsApp — no third-party npm dependencies, so no install step.
FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DB_PATH=/data/lost-lead.db BACKUP_DIR=/data/backups
WORKDIR /app
COPY package.json server.js cli.js ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY vendor ./vendor
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
