# ---------- build stage ----------
FROM node:20-alpine AS build
# Header badge: "Production" on the :80 stack, "Testing" on :8030
ARG VITE_ENV_LABEL=AMS
ENV VITE_ENV_LABEL=$VITE_ENV_LABEL
WORKDIR /app
# Some networks block registry.npmjs.org — compose passes NPM_REGISTRY from the
# env file (e.g. a reachable mirror); the default keeps upstream npm.
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "$NPM_REGISTRY"
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- runtime stage ----------
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
