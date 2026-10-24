# Multi-stage build: dev dependencies and sources stay in the build stage; the runtime image holds
# production dependencies and compiled JavaScript only, and runs as the non-root `node` user.
# Pin the base image by digest before the first deploy.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production && yarn cache clean

FROM node:24-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
