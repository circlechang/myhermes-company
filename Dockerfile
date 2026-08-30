# MyHermesCompany — 多階段：node 建前端 → python 執行伺服器（不含 Hermes Agent 本體）
# Hermes 用 HERMES_API_URL 指向另一台／另一容器的 gateway API server（見 docs/DEPLOY.md）
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# vite.config.ts 的 outDir 是 ../server/studio/web_dist
RUN mkdir -p /src/server/studio && npm run build

FROM python:3.12-slim AS runtime
LABEL org.opencontainers.image.title="MyHermesCompany" \
      org.opencontainers.image.description="每個人都有一間 AI 公司 — Hermes Agent 生態的第三方工作臺"
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    STUDIO_HOST=0.0.0.0 STUDIO_PORT=8700 STUDIO_HOME=/data HERMES_HOME=/hermes \
    STUDIO_DB=/data/studio.db
WORKDIR /app
COPY server/pyproject.toml server/README.md ./
COPY server/studio ./studio
COPY --from=web /src/server/studio/web_dist ./studio/web_dist
RUN pip install --no-cache-dir . && rm -rf /root/.cache
RUN useradd -r -u 10001 -d /data studio && mkdir -p /data /hermes && chown -R studio:studio /data /hermes
USER studio
VOLUME ["/data"]
EXPOSE 8700
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8700/health',timeout=3).status==200 else 1)"
CMD ["myhermescompany", "start"]
