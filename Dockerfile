# Use an official Python image for the backend
FROM python:3.11-slim AS backend

WORKDIR /app

# Install backend dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY main.py ./

# --- Frontend build stage ---
FROM node:20 AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Final stage: serve frontend and backend ---
FROM python:3.11-slim

# Install a simple static file server for the frontend
RUN apt-get update && apt-get install -y nginx && rm -rf /var/lib/apt/lists/*

# Copy backend from build stage
WORKDIR /app
COPY --from=backend /app /app

# Install all backend dependencies (including requests, etc.)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy built frontend
COPY --from=frontend-build /frontend/dist /frontend/dist

# Nginx config for serving frontend
RUN rm /etc/nginx/sites-enabled/default
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose ports
EXPOSE 80
EXPOSE 8000

# Start both backend and nginx
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port 8000 & nginx -g 'daemon off;'"]
