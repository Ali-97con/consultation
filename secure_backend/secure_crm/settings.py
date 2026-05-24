"""
Django settings with comprehensive security hardening.
All secrets loaded from .env file via django-environ.
"""
import os
from pathlib import Path
import environ

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent

# Load environment variables from .env file
env = environ.Env()
environ.Env.read_env(os.path.join(BASE_DIR, '.env'))

# ─── CORE ────────────────────────────────────────────────────────────────────
SECRET_KEY = env('SECRET_KEY')
DEBUG = env.bool('DEBUG', default=False)
ALLOWED_HOSTS = env.list('ALLOWED_HOSTS', default=['localhost', '127.0.0.1'])

# ─── APPS ────────────────────────────────────────────────────────────────────
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # Third-party
    'channels',
    'csp',
    'rest_framework',
    # Project apps
    'accounts.apps.AccountsConfig',
    'rbac.apps.RbacConfig',
    'waf.apps.WafConfig',
    'notifications.apps.NotificationsConfig',
    'analytics.apps.AnalyticsConfig',
    'activity_log.apps.ActivityLogConfig',
    'reports.apps.ReportsConfig',
    'backups.apps.BackupsConfig',
]

# ─── MIDDLEWARE (order matters!) ───────────────────────────────────────────
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    # Custom WAF middleware — runs very early to block attacks
    'waf.middleware.WAFMiddleware',
    # Rate limiting middleware
    'waf.middleware.RateLimitMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    # Security headers middleware
    'secure_crm.middleware.SecurityHeadersMiddleware',
    # Activity logging middleware
    'activity_log.middleware.ActivityLogMiddleware',
    # CSP
    'csp.middleware.CSPMiddleware',
]

ROOT_URLCONF = 'secure_crm.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
                'notifications.context_processors.unread_notifications',
            ],
        },
    },
]

# WSGI/ASGI — use ASGI for Django Channels
WSGI_APPLICATION = 'secure_crm.wsgi.application'
ASGI_APPLICATION = 'secure_crm.asgi.application'

# ─── DATABASE ────────────────────────────────────────────────────────────────
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': env('DB_NAME'),
        'USER': env('DB_USER'),
        'PASSWORD': env('DB_PASSWORD'),
        'HOST': env('DB_HOST', default='localhost'),
        'PORT': env('DB_PORT', default='5432'),
        # Connection pool settings for performance + security
        'CONN_MAX_AGE': 60,
        'OPTIONS': {
            'sslmode': 'prefer',  # Use SSL with the database if available
        },
    }
}

# ─── CUSTOM USER MODEL ───────────────────────────────────────────────────────
AUTH_USER_MODEL = 'accounts.User'

# ─── AUTHENTICATION BACKENDS ─────────────────────────────────────────────────
AUTHENTICATION_BACKENDS = [
    'accounts.backends.EmailBackend',  # Login with email instead of username
]

# ─── PASSWORD VALIDATION (Section 1: Strong Password Policy) ─────────────────
AUTH_PASSWORD_VALIDATORS = [
    # Minimum 16 characters
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
        'OPTIONS': {'min_length': 16},
    },
    # Cannot be too similar to username/email
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    # Cannot be a common password
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    # Cannot be entirely numeric
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
    # Custom: must have uppercase, lowercase, numbers, symbols
    {'NAME': 'accounts.validators.StrongPasswordValidator'},
]

# ─── SESSION SECURITY (Section 1: Session timeout) ───────────────────────────
SESSION_COOKIE_AGE = 1800           # 30 minutes of total session life
SESSION_SAVE_EVERY_REQUEST = True   # Reset timer on each request (inactivity timeout)
SESSION_COOKIE_SECURE = True        # Only send over HTTPS (Section 2)
SESSION_COOKIE_HTTPONLY = True      # Prevent JS access (Section 2)
SESSION_COOKIE_SAMESITE = 'Strict'  # CSRF protection
SESSION_ENGINE = 'django.contrib.sessions.backends.db'

# ─── CSRF PROTECTION (Section 4) ─────────────────────────────────────────────
CSRF_COOKIE_SECURE = True           # Only send over HTTPS
CSRF_COOKIE_HTTPONLY = True         # Prevent JS access
CSRF_COOKIE_SAMESITE = 'Strict'
CSRF_TRUSTED_ORIGINS = [f'https://{h}' for h in ALLOWED_HOSTS if h not in ('localhost', '127.0.0.1')]

# ─── HTTPS / SSL (Section 2) ─────────────────────────────────────────────────
SECURE_SSL_REDIRECT = not DEBUG                    # Force HTTPS
SECURE_HSTS_SECONDS = 31536000                     # 1 year
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True

# ─── SECURITY HEADERS (Section 13) ───────────────────────────────────────────
X_FRAME_OPTIONS = 'DENY'

# Content Security Policy (django-csp)
CSP_DEFAULT_SRC = ("'self'",)
CSP_SCRIPT_SRC = ("'self'", "'unsafe-inline'", "cdn.jsdelivr.net")  # Allow Chart.js CDN
CSP_STYLE_SRC = ("'self'", "'unsafe-inline'", "cdn.jsdelivr.net")
CSP_IMG_SRC = ("'self'", "data:")
CSP_CONNECT_SRC = ("'self'", "ws:", "wss:")    # Allow WebSocket connections
CSP_FONT_SRC = ("'self'",)
CSP_FRAME_ANCESTORS = ("'none'",)

# ─── EMAIL ────────────────────────────────────────────────────────────────────
EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend'
EMAIL_HOST = env('EMAIL_HOST', default='smtp.gmail.com')
EMAIL_PORT = env.int('EMAIL_PORT', default=587)
EMAIL_USE_TLS = env.bool('EMAIL_USE_TLS', default=True)
EMAIL_HOST_USER = env('EMAIL_HOST_USER', default='')
EMAIL_HOST_PASSWORD = env('EMAIL_HOST_PASSWORD', default='')
DEFAULT_FROM_EMAIL = env('DEFAULT_FROM_EMAIL', default='noreply@example.com')
OWNER_EMAIL = env('OWNER_EMAIL', default='')

# ─── CHANNELS (WebSocket for real-time notifications) ────────────────────────
CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {'hosts': [env('REDIS_URL', default='redis://localhost:6379/0')]},
    },
}

# ─── CACHE (Redis) ────────────────────────────────────────────────────────────
CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.redis.RedisCache',
        'LOCATION': env('REDIS_URL', default='redis://localhost:6379/0'),
    }
}

# ─── ENCRYPTION (Section 4: AES-256 via Fernet) ──────────────────────────────
ENCRYPTION_KEY = env('ENCRYPTION_KEY', default='').encode()

# ─── 2FA ─────────────────────────────────────────────────────────────────────
TOTP_ISSUER_NAME = env('TOTP_ISSUER_NAME', default='SecureCRM')

# ─── RATE LIMITING ───────────────────────────────────────────────────────────
# Max failed login attempts before IP block
LOGIN_MAX_ATTEMPTS = 5
LOGIN_BLOCK_DURATION = 900  # 15 minutes in seconds
# Global rate limit: 100 requests/minute per IP
RATE_LIMIT_REQUESTS = 100
RATE_LIMIT_WINDOW = 60  # seconds

# ─── MEMBER APPROVAL ─────────────────────────────────────────────────────────
PENDING_ACCOUNT_EXPIRY_HOURS = 48

# ─── LOGGING ─────────────────────────────────────────────────────────────────
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'file': {
            'level': 'WARNING',
            'class': 'logging.FileHandler',
            'filename': BASE_DIR / 'logs' / 'django.log',
            'formatter': 'verbose',
        },
        'security_file': {
            'level': 'INFO',
            'class': 'logging.FileHandler',
            'filename': BASE_DIR / 'logs' / 'security.log',
            'formatter': 'verbose',
        },
    },
    'loggers': {
        'django': {'handlers': ['file'], 'level': 'WARNING', 'propagate': True},
        'security': {'handlers': ['security_file'], 'level': 'INFO', 'propagate': False},
    },
}

# ─── STATIC / MEDIA ──────────────────────────────────────────────────────────
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_STORAGE = 'whitenoise.storage.CompressedManifestStaticFilesStorage'
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

# ─── MISC ─────────────────────────────────────────────────────────────────────
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

LOGIN_URL = '/accounts/login/'
LOGIN_REDIRECT_URL = '/analytics/dashboard/'
LOGOUT_REDIRECT_URL = '/accounts/login/'

# Backup settings
BACKUP_LOCAL_PATH = BASE_DIR / 'backups' / 'files'
USE_S3_BACKUP = env.bool('USE_S3_BACKUP', default=False)
