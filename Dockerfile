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
# Non-secret settings from the Cloud Build trigger (see cloudbuild.yaml). An empty value counts as
# unset and the API applies its default. Secrets are not declared here: Cloud Run injects them.
ARG LOG_LEVEL
ARG BODY_LIMIT_BYTES
ARG REQUEST_TIMEOUT_MS
ARG JWT_KEY_ID
ARG JWT_ISSUER
ARG JWT_AUDIENCE
ARG SESSION_TTL_MINUTES
ARG CHALLENGE_TTL_MINUTES
ARG ALLOW_IN_MEMORY_STORE
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080     LOG_LEVEL=${LOG_LEVEL}     BODY_LIMIT_BYTES=${BODY_LIMIT_BYTES}     REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS}     JWT_KEY_ID=${JWT_KEY_ID}     JWT_ISSUER=${JWT_ISSUER}     JWT_AUDIENCE=${JWT_AUDIENCE}     SESSION_TTL_MINUTES=${SESSION_TTL_MINUTES}     CHALLENGE_TTL_MINUTES=${CHALLENGE_TTL_MINUTES}     ALLOW_IN_MEMORY_STORE=${ALLOW_IN_MEMORY_STORE}
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
