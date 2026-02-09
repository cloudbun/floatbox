# Stage 1: Compile Go to WASM
FROM golang:1.23-alpine AS go-wasm

WORKDIR /build

COPY src/go/ ./src/go/

WORKDIR /build/src/go
RUN GOOS=js GOARCH=wasm go build -o /build/uar_engine.wasm ./cmd/wasm/
RUN cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" /build/wasm_exec.js

# Stage 2: Build React/Vite frontend
FROM node:22-alpine AS frontend

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Inject WASM artifacts from stage 1
COPY --from=go-wasm /build/uar_engine.wasm public/uar_engine.wasm
COPY --from=go-wasm /build/wasm_exec.js public/wasm_exec.js

RUN npx vite build

# Stage 3: Serve with hardened Nginx
FROM nginx:1.27-alpine-slim AS runtime

# Remove default config and static files
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf

# Inline nginx configuration
COPY <<'EOF' /etc/nginx/nginx.conf
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {
    worker_connections 256;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Temp paths writable by non-root user (all under /tmp tmpfs)
    client_body_temp_path /tmp/client_body;
    proxy_temp_path /tmp/proxy;
    fastcgi_temp_path /tmp/fastcgi;
    uwsgi_temp_path /tmp/uwsgi;
    scgi_temp_path /tmp/scgi;

    log_format main '$remote_addr - [$time_local] "$request" $status $body_bytes_sent';
    access_log /dev/stdout main;

    sendfile on;
    tcp_nopush on;
    keepalive_timeout 30;

    # Gzip compression
    gzip on;
    gzip_static on;
    gzip_types text/plain text/css application/javascript application/json application/wasm;
    gzip_min_length 1024;
    gzip_vary on;

    server {
        listen 8080;
        server_name _;
        root /usr/share/nginx/html;
        index index.html;

        # Security headers
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "no-referrer" always;

        # Hashed static assets — immutable cache
        location /assets/ {
            expires max;
            add_header Cache-Control "public, max-age=31536000, immutable" always;
            add_header Cross-Origin-Opener-Policy "same-origin" always;
            add_header Cross-Origin-Embedder-Policy "require-corp" always;
            add_header X-Content-Type-Options "nosniff" always;
        }

        # WASM binary — immutable cache
        location ~* \.wasm$ {
            expires max;
            add_header Cache-Control "public, max-age=31536000, immutable" always;
            add_header Cross-Origin-Opener-Policy "same-origin" always;
            add_header Cross-Origin-Embedder-Policy "require-corp" always;
            add_header X-Content-Type-Options "nosniff" always;
        }

        # index.html — no cache (so SW updates work)
        location = /index.html {
            add_header Cache-Control "no-cache" always;
            add_header Cross-Origin-Opener-Policy "same-origin" always;
            add_header Cross-Origin-Embedder-Policy "require-corp" always;
            add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'" always;
            add_header X-Content-Type-Options "nosniff" always;
            add_header X-Frame-Options "DENY" always;
            add_header Referrer-Policy "no-referrer" always;
        }

        # SPA fallback — all routes serve index.html
        location / {
            try_files $uri $uri/ /index.html;
        }
    }
}
EOF

# Copy built frontend assets
COPY --from=frontend /app/dist /usr/share/nginx/html

# Create non-root user and set permissions
RUN addgroup -g 1000 -S appgroup && \
    adduser -u 1000 -S appuser -G appgroup && \
    chown -R appuser:appgroup /usr/share/nginx/html

USER 1000

EXPOSE 8080

ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
