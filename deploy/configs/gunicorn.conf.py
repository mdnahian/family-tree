bind = "127.0.0.1:8000"

# 1 worker + 4 threads to conserve RAM on $6 droplet
workers = 1
worker_class = "gthread"
threads = 4

# 120s timeout for large file uploads
timeout = 120

accesslog = "/var/log/family-tree/gunicorn-access.log"
errorlog = "/var/log/family-tree/gunicorn-error.log"
loglevel = "info"

graceful_timeout = 30
