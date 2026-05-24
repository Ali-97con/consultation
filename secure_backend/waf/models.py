"""Track blocked IPs from WAF rules."""
import uuid
from django.db import models
from django.utils import timezone


class BlockedIP(models.Model):
    """Record of IPs blocked by WAF rules (shown in analytics dashboard)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    ip_address = models.GenericIPAddressField(db_index=True)
    reason = models.CharField(max_length=200)
    blocked_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField(null=True, blank=True)
    is_permanent = models.BooleanField(default=False)

    class Meta:
        db_table = 'waf_blocked_ip'

    def __str__(self):
        return f'{self.ip_address} — {self.reason}'
