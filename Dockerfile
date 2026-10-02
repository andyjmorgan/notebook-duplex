FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
WORKDIR /app
RUN addgroup -S notebook && adduser -S -G notebook notebook && mkdir -p /data && chown notebook:notebook /data
COPY --from=build --chown=notebook:notebook /app/package.json ./
COPY --from=build --chown=notebook:notebook /app/node_modules ./node_modules
COPY --from=build --chown=notebook:notebook /app/dist ./dist
COPY --from=build --chown=notebook:notebook /app/server ./server
COPY --from=build --chown=notebook:notebook /app/shared ./shared
USER notebook
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.mjs"]
