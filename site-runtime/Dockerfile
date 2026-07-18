FROM oven/bun:1.3.11

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV SITE_ARTIFACT_DIR=/app/public

COPY --chown=bun:bun runtime.ts ./runtime.ts
COPY --chown=bun:bun public ./public

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/health');process.exit(r.ok?0:1)"]

CMD ["bun", "run", "runtime.ts"]
