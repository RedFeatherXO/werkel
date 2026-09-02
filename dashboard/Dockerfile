# No build step and no dependencies — the dashboard is plain Node.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
COPY public ./public

ENV PORT=7777 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

RUN mkdir -p /data && addgroup -S fleet && adduser -S fleet -G fleet && chown -R fleet:fleet /data /app
USER fleet

EXPOSE 7777
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7777)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
