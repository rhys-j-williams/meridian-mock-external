# Build context is the parent workspace holding the sibling clones (northgate-mock-external and
# northgate-platform-services), because @northgate/domain-fixtures is a file: dependency on
# ../northgate-platform-services. Dockerfile.dockerignore next to this file keeps the context
# small (needs BuildKit, which every Docker since 23 has).
#   docker build -f northgate-mock-external/aggregio-mock/Dockerfile -t northgate/aggregio-mock .
# One image per mock so compose can rebuild a single service. PLAT-2244.
FROM node:18.19.0-alpine3.19 AS build
WORKDIR /estate
COPY northgate-platform-services/libs/ts/domain-fixtures ./northgate-platform-services/libs/ts/domain-fixtures
RUN cd northgate-platform-services/libs/ts/domain-fixtures && npm ci --ignore-scripts && npm run build
WORKDIR /estate/northgate-mock-external
COPY northgate-mock-external ./
RUN npm ci --ignore-scripts \
 && npm run build --workspace lib/mock-kit \
 && npm run build --workspace aggregio-mock

FROM node:18.19.0-alpine3.19
ENV NODE_ENV=production
WORKDIR /estate
COPY --from=build /estate ./
USER node
WORKDIR /estate/northgate-mock-external/aggregio-mock
CMD ["node", "dist/main.js"]
