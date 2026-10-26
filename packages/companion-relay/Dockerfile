FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org \
    && npm cache clean --force
COPY src ./src

# Linux host networking keeps the reverse-proxy peer genuinely loopback. A
# public bind or a Docker bridge peer cannot assert trusted forwarded headers.
ENV NODE_ENV=production \
    LOLICODE_COMPANION_HOST=127.0.0.1 \
    LOLICODE_COMPANION_PORT=13010 \
    LOLICODE_COMPANION_STATE_DIRECTORY=/var/lib/lolicode-companion
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.LOLICODE_COMPANION_PORT+'/health').then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"
CMD ["node", "src/main.mjs"]
