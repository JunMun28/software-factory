# Built from the REPO ROOT context (ADR 0017 Phase 2) — same shape as
# apps/intake/Dockerfile: the multi-project Angular workspace needs the root.
#   docker build -f apps/console/Dockerfile -t sf-console .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build console

FROM nginx:alpine
COPY --from=build /app/dist/console/browser /usr/share/nginx/html
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
