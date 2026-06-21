# Built from the REPO ROOT context (ADR 0017 Phase 2): the Angular workspace
# now lives at the root with a single node_modules, so the build needs
# angular.json, tsconfig.json, apps/ and packages/ — not just this app's folder.
#   docker build -f apps/intake/Dockerfile -t sf-intake .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build intake

FROM nginx:alpine
COPY --from=build /app/dist/intake/browser /usr/share/nginx/html
COPY apps/intake/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
