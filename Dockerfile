FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
EXPOSE 8787
ENV PORT=8787
CMD ["node", "server.js"]
