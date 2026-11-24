# Runs OneInbox as a website. Needs BASE_URL, APP_PASSWORD and APP_SECRET; keep /data on a persistent disk.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
ENV HOST=0.0.0.0 PORT=4747 ONEINBOX_DATA=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 4747
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
