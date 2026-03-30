import os
from datetime import timedelta

basedir = os.path.abspath(os.path.dirname(__file__))


class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
    SQLALCHEMY_DATABASE_URI = 'sqlite:///' + os.path.join(basedir, 'instance', 'family-tree.db')
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Upload settings
    UPLOAD_FOLDER = os.path.join(basedir, 'uploads')
    MAX_CONTENT_LENGTH = 20 * 1024 * 1024  # 20 MB
    ALLOWED_IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'webp'}
    ALLOWED_DOC_EXTENSIONS = {'pdf', 'doc', 'docx'}

    # Session / auth
    REMEMBER_COOKIE_DURATION = timedelta(days=30)
    PERMANENT_SESSION_LIFETIME = timedelta(days=30)

    # SendGrid
    SENDGRID_API_KEY = os.environ.get('SENDGRID_API_KEY')
    SENDGRID_FROM_EMAIL = os.environ.get('SENDGRID_FROM_EMAIL', 'noreply@example.com')

    # App
    APP_NAME = 'Family Tree'
    APP_VERSION = '1.1.4'  # bump to bust static file caches
    APP_URL = os.environ.get('APP_URL', 'http://localhost:5000')

    # Profile photo thumbnail size
    PROFILE_PHOTO_MAX_SIZE = (800, 800)

    # Storage backend: 'local' or 's3'
    STORAGE_BACKEND = os.environ.get('STORAGE_BACKEND', 'local')
    AWS_S3_BUCKET = os.environ.get('AWS_S3_BUCKET')
    AWS_S3_REGION = os.environ.get('AWS_S3_REGION', 'us-east-1')
    CLOUDFRONT_DOMAIN = os.environ.get('CLOUDFRONT_DOMAIN')
    CLOUDFRONT_KEY_PAIR_ID = os.environ.get('CLOUDFRONT_KEY_PAIR_ID')
    CLOUDFRONT_PRIVATE_KEY_PATH = os.environ.get('CLOUDFRONT_PRIVATE_KEY_PATH')
    CLOUDFRONT_COOKIE_DURATION = int(os.environ.get('CLOUDFRONT_COOKIE_DURATION', '86400'))
