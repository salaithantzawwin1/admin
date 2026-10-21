# ---------- build stage ----------
# Full Debian image ships OpenSSL 3 + libssl3, which Prisma 5 detects correctly
# (alpine/musl detection is broken on this network and yields openssl-1.1 engines).
FROM node:20-bookworm AS build
WORKDIR /app
# Some networks block registry.npmjs.org — compose passes NPM_REGISTRY from the
# env file (e.g. a reachable mirror); the default keeps upstream npm.
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "$NPM_REGISTRY"
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build
# Deploy provenance: the deploy scripts stamp the checkout HEAD (BUILD_COMMIT)
# into the image and assert the RUNNING container still carries it — a stale or
# cache-lied build then fails the deploy loudly instead of shipping old code.
ARG BUILD_COMMIT=unknown
RUN echo "$BUILD_COMMIT" > /app/dist/BUILD_COMMIT

# ---------- runtime stage ----------
FROM node:20-bookworm
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seed.js && node dist/main.js"]
