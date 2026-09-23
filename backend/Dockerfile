# ---------- build stage ----------
# Full Debian image ships OpenSSL 3 + libssl3, which Prisma 5 detects correctly
# (alpine/musl detection is broken on this network and yields openssl-1.1 engines).
FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

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
