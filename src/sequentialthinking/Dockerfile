FROM node:20-slim

WORKDIR /app
COPY package.json ./

# Install project-level deps first for cache efficiency
RUN npm install --production

# Copy source and build MCP server
COPY . .
RUN npm run build

# Wrapper deps (express, cors, body-parser already in package.json)
EXPOSE 3000
CMD ["node", "servers/src/sequentialthinking/server.js"]
