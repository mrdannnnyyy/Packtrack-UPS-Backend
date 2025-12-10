# Use official Node.js image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source
COPY . .

# Cloud Run expects port 8080
ENV PORT=8080
EXPOSE 8080

# Start command
CMD [ "node", "server.js" ]
