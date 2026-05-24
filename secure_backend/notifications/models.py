"""
Notification model — stored in DB, delivered via WebSocket in real-time.
Kept for 90 days (Section 7).
"""
import uuid
from django.db import models
from django.conf import settings
from django.utils import timezone


class Notification(models.Model):
    class Type(models.TextChoices):
        NEW_REGISTRATION = 'new_registration', 'New Registration Request'
        MEMBER_APPROVED = 'member_approved', 'Member Approved'
        MEMBER_REJECTED = 'member_rejected', 'Member Rejected'
        ROLE_CHANGED = 'role_changed', 'Role Changed'
        MEMBER_SUSPENDED = 'member_suspended', 'Member Suspended'
        MEMBER_DELETED = 'member_deleted', 'Member Deleted'
        NEW_REPORT = 'new_report', 'New Report'
        REPORT_RESOLVED = 'report_resolved', 'Report Resolved'
        LOGIN_SPIKE = 'login_spike', 'Failed Login Spike'
        BACKUP_DONE = 'backup_done', 'Backup Completed'
        BACKUP_FAILED = 'backup_failed', 'Backup Failed'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='notifications'
    )
    notification_type = models.CharField(max_length=30, choices=Type.choices)
    message = models.TextField()
    action_url = models.CharField(max_length=500, blank=True)
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = 'notifications_notification'
        ordering = ['-created_at']
        indexes = [models.Index(fields=['recipient', 'is_read'])]

    def __str__(self):
        return f'{self.notification_type} -> {self.recipient}'

    @classmethod
    def cleanup_old(cls):
        """Delete notifications older than 90 days."""
        from datetime import timedelta
        cutoff = timezone.now() - timedelta(days=90)
        cls.objects.filter(created_at__lt=cutoff).delete()
