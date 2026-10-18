# Fermata's analytics store: a tiny Node service in front of Firestore (free tier).
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
USER node
ENV PORT=8080
CMD ["node", "server.mjs"]
