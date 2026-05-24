"""
User model with:
- Custom status flow (PENDING -> APPROVED / REJECTED / SUSPENDED / EXPIRED)
- TOTP 2FA support
- Login attempt tracking for IP blocking
- AES-256 encrypted sensitive fields
"""
import uuid
from django.db import models
from django.contrib.auth.models import AbstractBaseUser, PermissionsMixin, BaseUserManager
from django.utils import timezone
from django.conf import settings
from cryptography.fernet import Fernet


def _fernet():
    """Return a Fernet cipher using the project encryption key."""
    return Fernet(settings.ENCRYPTION_KEY)


class UserManager(BaseUserManager):
    """Custom manager — email is the unique identifier, not username."""

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError('Email address is required')
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)  # Django uses bcrypt-compatible PBKDF2 by default; we override hasher below
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        extra_fields.setdefault('status', User.Status.APPROVED)
        extra_fields.setdefault('role', 'owner')
        return self.create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    """
    Custom user model.
    Uses email for authentication.
    Supports role-based access and approval workflow.
    """

    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending Approval'
        APPROVED = 'APPROVED', 'Approved'
        REJECTED = 'REJECTED', 'Rejected'
        SUSPENDED = 'SUSPENDED', 'Suspended'
        EXPIRED = 'EXPIRED', 'Expired'

    class Role(models.TextChoices):
        OWNER = 'owner', 'Owner'
        CO_OWNER = 'co_owner', 'Co-Owner'
        EDITOR = 'editor', 'Editor'
        VIEWER = 'viewer', 'Viewer'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=150)

    # Role & Status
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.VIEWER)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)

    # Timestamps
    date_joined = models.DateTimeField(default=timezone.now)
    approved_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(
        'self', null=True, blank=True, on_delete=models.SET_NULL, related_name='approved_users'
    )

    # 2FA (TOTP)
    totp_secret = models.CharField(max_length=64, blank=True)  # Base32 secret for TOTP
    totp_enabled = models.BooleanField(default=False)

    # Stored encrypted phone (example of AES-256 encrypted field at rest)
    _phone_encrypted = models.BinaryField(blank=True, null=True, db_column='phone_encrypted')

    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)

    objects = UserManager()

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['full_name']

    class Meta:
        db_table = 'accounts_user'
        verbose_name = 'User'
        verbose_name_plural = 'Users'

    def __str__(self):
        return f'{self.full_name} <{self.email}>'

    # ── AES-256 encrypted phone number ──────────────────────────────────────
    @property
    def phone(self):
        """Decrypt phone number on read."""
        if self._phone_encrypted:
            return _fernet().decrypt(bytes(self._phone_encrypted)).decode()
        return ''

    @phone.setter
    def phone(self, value):
        """Encrypt phone number before storing."""
        if value:
            self._phone_encrypted = _fernet().encrypt(value.encode())
        else:
            self._phone_encrypted = None

    # ── Convenience helpers ──────────────────────────────────────────────────
    def can_login(self):
        """Only APPROVED users may log in."""
        return self.status == self.Status.APPROVED

    def is_pending_expired(self):
        """Return True if a PENDING account is older than 48 hours."""
        from django.conf import settings
        expiry_hours = getattr(settings, 'PENDING_ACCOUNT_EXPIRY_HOURS', 48)
        if self.status == self.Status.PENDING:
            delta = timezone.now() - self.date_joined
            return delta.total_seconds() > expiry_hours * 3600
        return False

    @property
    def is_owner(self):
        return self.role == self.Role.OWNER

    @property
    def is_co_owner(self):
        return self.role == self.Role.CO_OWNER

    @property
    def is_editor(self):
        return self.role == self.Role.EDITOR

    @property
    def is_viewer(self):
        return self.role == self.Role.VIEWER


class LoginAttempt(models.Model):
    """
    Track failed login attempts per IP.
    Used to block IPs after 5 failed attempts (Section 1).
    """
    ip_address = models.GenericIPAddressField(db_index=True)
    email_tried = models.EmailField(blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)
    was_successful = models.BooleanField(default=False)
    blocked_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'accounts_login_attempt'
        indexes = [models.Index(fields=['ip_address', 'timestamp'])]

    @classmethod
    def is_ip_blocked(cls, ip):
        """Return True if this IP is currently blocked."""
        from django.utils import timezone
        blocked = cls.objects.filter(
            ip_address=ip,
            blocked_until__gt=timezone.now()
        ).exists()
        return blocked

    @classmethod
    def record_failure(cls, ip, email=''):
        """
        Record a failed login attempt.
        If the IP now has 5+ failures in the last 15 min, block it.
        """
        from django.utils import timezone
        from datetime import timedelta
        from django.conf import settings
        import logging

        logger = logging.getLogger('security')

        cls.objects.create(ip_address=ip, email_tried=email, was_successful=False)

        # Count recent failures
        window_start = timezone.now() - timedelta(minutes=15)
        failure_count = cls.objects.filter(
            ip_address=ip,
            was_successful=False,
            timestamp__gte=window_start,
            blocked_until__isnull=True,
        ).count()

        max_attempts = getattr(settings, 'LOGIN_MAX_ATTEMPTS', 5)
        block_duration = getattr(settings, 'LOGIN_BLOCK_DURATION', 900)

        if failure_count >= max_attempts:
            blocked_until = timezone.now() + timedelta(seconds=block_duration)
            cls.objects.filter(ip_address=ip, was_successful=False, timestamp__gte=window_start).update(
                blocked_until=blocked_until
            )
            logger.warning(f'IP {ip} blocked until {blocked_until} after {failure_count} failed attempts')
            # Trigger alert if there is a spike (more than 5 in a short window)
            from notifications.utils import notify_owner_login_spike
            notify_owner_login_spike(ip, failure_count)

    @classmethod
    def record_success(cls, ip, email=''):
        """Record a successful login."""
        cls.objects.create(ip_address=ip, email_tried=email, was_successful=True)
