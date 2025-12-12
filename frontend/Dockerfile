# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_BASE_URL=http://localhost:3000
ARG VITE_SENTRY_DSN=
ARG VITE_OTEL_EXPORTER_URL=http://localhost:4318/v1/traces
ARG VITE_JAEGER_UI_URL=http://localhost:16686
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_OTEL_EXPORTER_URL=$VITE_OTEL_EXPORTER_URL
ENV VITE_JAEGER_UI_URL=$VITE_JAEGER_UI_URL
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
RUN npm install -g serve
COPY --from=build /app/dist ./dist
EXPOSE 4173
ENV HOST=0.0.0.0
CMD ["serve", "-s", "dist", "-l", "4173"]
