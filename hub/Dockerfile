FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Cache-bust: forces rebuild on each deploy to pick up source changes
ARG CACHE_BUST=rxfit-v2

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
