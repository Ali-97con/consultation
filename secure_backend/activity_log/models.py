"""
Activity log model — stores all member actions (Section 9).
Kept 6 months, then auto-archived.
"""
import uuid
from django.db import models
from django.conf import settings
from django.utils import timezone


class ActivityLog(models.Model):
    """One record per user action."""

    class ActionType(models.TextChoices):
        LOGIN = 'login', 'Login'
        LOGIN_2FA = 'login_2fa', 'Login (2FA)'
        LOGOUT = 'logout', 'Logout'
        LOGIN_FAILED = 'login_failed', 'Failed Login'
        REGISTRATION = 'registration_request', 'Registration Request'
        USER_APPROVED = 'user_approved', 'User Approved'
        USER_REJECTED = 'user_rejected', 'User Rejected'
        ROLE_CHANGED = 'role_changed', 'Role Changed'
        CONTENT_CREATED = 'content_created', 'Content Created'
        CONTENT_EDITED = 'content_edited', 'Content Edited'
        CONTENT_DELETED = 'content_deleted', 'Content Deleted'
        PASSWORD_CHANGED = 'password_changed', 'Password Changed'
        REPORT_SUBMITTED = 'report_submitted', 'Report Submitted'
        TWO_FA_ENABLED = '2fa_enabled', '2FA Enabled'
        MEMBER_SUSPENDED = 'member_suspended', 'Member Suspended'
        MEMBER_DELETED = 'member_deleted', 'Member Deleted'
        BACKUP_RUN = 'backup_run', 'Backup Run'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name='activity_logs'
    )
    action_type = models.CharField(max_length=50, choices=ActionType.choices, db_index=True)
    details = models.JSONField(default=dict)   # Flexible JSON — stores context-specific data
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = 'activity_logs'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', 'created_at']),
            models.Index(fields=['action_type', 'created_at']),
        ]

    def __str__(self):
        return f'{self.user} | {self.action_type} | {self.created_at}'

    @classmethod
    def auto_archive(cls):
        """Delete logs older than 6 months (called by scheduled task)."""
        cutoff = timezone.now() - timezone.timedelta(days=180)
        cls.objects.filter(created_at__lt=cutoff).delete()
