# CourseTA 前端镜像：Node 构建 → nginx 托管静态文件并反向代理 /api
#
# 构建上下文是 web/（见根目录 docker-compose.yml 的 context: ./web）。
# nginx.conf 同时负责 SSE 透传（proxy_buffering off + 长读超时），
# 所以浏览器只与 nginx 同源通信，同源部署不需要配 CORS。

# ---------- 构建阶段 ----------
FROM node:24-alpine AS build

WORKDIR /app

# 先装依赖：只要 package-lock.json 不变，这层就能复用缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
FROM nginx:1.27-alpine

# 站点配置（/api 反代 + SSE 友好 + SPA 回退 + 上传体积上限）
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 构建产物
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
