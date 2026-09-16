FROM node:24-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend
COPY frontend ./frontend
RUN npm run build --prefix frontend

FROM node:24-bookworm-slim AS backend-base
WORKDIR /app
COPY package.json ./
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm ci --prefix backend --omit=dev
COPY backend ./backend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
WORKDIR /app/backend
USER node
CMD ["node", "src/index.js"]

FROM backend-base AS test
USER root
RUN npm ci --include=dev
USER node
CMD ["npm", "run", "test:integration"]

FROM backend-base AS backend
