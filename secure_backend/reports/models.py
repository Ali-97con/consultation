"""
Member report system (Section 10).
Stored for 1 year.
"""
import uuid
from django.db import models
from django.conf import settings
from django.utils import timezone


class Report(models.Model):
    class Status(models.TextChoices):
        OPEN = 'OPEN', 'Open'
        WARNED = 'WARNED', 'Warning Issued'
        SUSPENDED = 'SUSPENDED', 'Reported User Suspended'
        DELETED = 'DELETED', 'Reported User Deleted'
        DISMISSED = 'DISMISSED', 'Dismissed'

    class Reason(models.TextChoices):
        HARASSMENT = 'harassment', 'Harassment'
        SPAM = 'spam', 'Spam'
        ABUSE = 'abuse', 'Abuse of Permissions'
        INAPPROPRIATE = 'inappropriate', 'Inappropriate Content'
        OTHER = 'other', 'Other'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='reports_submitted'
    )
    reported_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='reports_received'
    )
    reason = models.CharField(max_length=50, choices=Reason.choices)
    description = models.TextField(max_length=2000)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    resolution = models.TextField(blank=True)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='reports_resolved'
    )
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = 'reports_report'
        ordering = ['-created_at']

    def __str__(self):
        return f'Report by {self.reporter} against {self.reported_user}'
