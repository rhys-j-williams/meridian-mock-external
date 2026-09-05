# Build context is the repository root, because @meridian/domain-fixtures is a file: dependency
# that lives in platform-services/. Dockerfile.dockerignore next to this file keeps the context
# small (needs BuildKit, which every Docker since 23 has).
#   docker build -f mock-external/triscore-mock/Dockerfile -t meridian/triscore-mock .
# One image per mock so compose can rebuild a single service. PLAT-2244.
FROM node:18.19.0-alpine3.19 AS build
WORKDIR /estate
COPY platform-services/libs/ts/domain-fixtures ./platform-services/libs/ts/domain-fixtures
RUN cd platform-services/libs/ts/domain-fixtures && npm ci --ignore-scripts && npm run build
WORKDIR /estate/mock-external
COPY mock-external ./
RUN npm ci --ignore-scripts \
 && npm run build --workspace lib/mock-kit \
 && npm run build --workspace triscore-mock

FROM node:18.19.0-alpine3.19
ENV NODE_ENV=production
WORKDIR /estate
COPY --from=build /estate ./
USER node
WORKDIR /estate/mock-external/triscore-mock
CMD ["node", "dist/main.js"]
