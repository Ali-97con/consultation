"""
Page visit tracking model for analytics dashboard.
Recorded by middleware on every request.
"""
import uuid
from django.db import models
from django.utils import timezone


class PageVisit(models.Model):
    """Record of each page visit — used for traffic analytics."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    path = models.CharField(max_length=500, db_index=True)
    ip_address = models.GenericIPAddressField()
    user_agent = models.CharField(max_length=500, blank=True)
    visited_at = models.DateTimeField(default=timezone.now, db_index=True)
    user = models.ForeignKey(
        'accounts.User', null=True, blank=True, on_delete=models.SET_NULL
    )

    class Meta:
        db_table = 'analytics_page_visit'
        indexes = [models.Index(fields=['visited_at', 'path'])]
