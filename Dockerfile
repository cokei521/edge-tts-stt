# syntax=docker/dockerfile:1
# VoiceCraft —— 容器化部署镜像
# 项目零运行时依赖（Node 18+ 自带 fetch / Request / Response / FormData / Blob / crypto），
# 因此无需 npm install，镜像只装 Node 运行时 + 源码。

FROM node:22-alpine AS base

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# 先只拷清单文件，便于利用构建缓存
COPY package.json ./

# 本项目没有 npm 依赖；若将来引入了依赖，取消下一行注释即可
# RUN npm ci --omit=dev

COPY index.js server.mjs ./

# 以非 root 用户运行（node 镜像内置的 node 用户 uid=1000）
USER node

EXPOSE 8080

# 健康检查：alpine 无 curl，改用 Node 自带的 fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
