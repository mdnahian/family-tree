# Family Tree

A web app for building and exploring your family tree. Upload photos, tag people, and let face recognition find matches automatically.

Built with Flask, SQLite, and a custom D3.js tree layout engine.

## Features

- Interactive family tree with pan/zoom and clickable branches
- Support for multiple spouses, divorce, remarriage, and complex relationships
- Photo uploads with automatic face detection and recognition (insightface)
- Person detail pages with biography, education, and tagged media
- Invite system and privacy controls
- Edit mode toggle to keep the UI clean by default

## Requirements

- Python 3.10+

## Local Setup

```bash
git clone https://github.com/mdnahian/family-tree.git
cd family-tree
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

Visit `http://localhost:5000`. On first run you will be prompted to create an admin account.

## Deployment

The `deploy/` directory contains everything needed to deploy on a DigitalOcean droplet.

```bash
# 1. Provision infrastructure
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars  # fill in your values
terraform init && terraform apply

# 2. Set up the server (one-time)
ssh root@<droplet-ip> 'bash -s' < deploy/setup-server.sh

# 3. Deploy the app
./deploy/deploy.sh root@<droplet-ip>

# 4. Create .env on the server
ssh root@<droplet-ip>
cp /opt/family-tree/deploy/.env.example /opt/family-tree/.env
nano /opt/family-tree/.env
systemctl start family-tree
```

See `deploy/` for Nginx, Gunicorn, systemd, and backup configs.

## Project Structure

```
app.py              Flask application and API routes
models.py           SQLAlchemy models (Person, Media, FaceDetection, etc.)
config.py           App configuration
face.py             Face detection/recognition using insightface
face_worker.py      Background worker for processing face jobs
static/js/          Tree layout engine and frontend app
static/css/         Styles
templates/          HTML templates
deploy/             Terraform, server configs, deploy scripts
```
