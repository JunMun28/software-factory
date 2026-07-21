# Built from the app-preview/ui context (this is a STANDALONE Angular workspace with
# its own package.json + package-lock.json + angular.json — NOT part of the root
# multi-project workspace like apps/console, so a ui-local context is simplest).
#   docker build -f app-preview/ui/Dockerfile -t sf-ngv0-ui:dev app-preview/ui
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build ui

FROM nginx:alpine
COPY --from=build /app/dist/ui/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
