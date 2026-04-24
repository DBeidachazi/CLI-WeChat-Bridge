FROM imbios/bun-node:latest-24-debian
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux git ca-certificates build-essential python3 curl wget xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV WECHAT_BRIDGE_WORKDIR=/root
ENV WECHAT_BRIDGE_SHARED_ROOT=/app/.linkai

COPY package.json package-lock.json bun.lock tsconfig.json ./
RUN npm install

COPY bin ./bin
COPY src ./src
COPY scripts ./scripts
COPY .linkai ./.linkai
COPY README.md LICENSE.txt ./

RUN chmod +x scripts/*.sh \
  && npm install -g .

CMD ["./scripts/start-bridge.sh"]
