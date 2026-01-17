FROM nginx:alpine

# Copy static files
COPY . /usr/share/nginx/html

# Copy entrypoint script
COPY entrypoint.sh /docker-entrypoint.d/99-config.sh

# Make executable
RUN chmod +x /docker-entrypoint.d/99-config.sh

# Nginx alpine runs entrypoint scripts in /docker-entrypoint.d/ automatically
