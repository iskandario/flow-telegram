FROM mcr.microsoft.com/playwright:v1.58.2-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/state && chown pwuser:pwuser /app/state
COPY vk-connector/*.mjs ./vk-connector/
USER pwuser
ENV HOST=0.0.0.0 PORT=8788 FLOW_SESSION_DIR=/app/state
EXPOSE 8788
CMD ["node", "vk-connector/server.mjs"]
