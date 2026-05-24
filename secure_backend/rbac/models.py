"""
Role change audit log.
Every role change is recorded: who changed it, from what to what, when.
"""
import uuid
from django.db import models
from django.conf import settings


class RoleChangeLog(models.Model):
    """Immutable audit record of every role change (Section 6)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    target_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='role_changes_received'
    )
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='role_changes_made'
    )
    old_role = models.CharField(max_length=20)
    new_role = models.CharField(max_length=20)
    timestamp = models.DateTimeField(auto_now_add=True)
    note = models.TextField(blank=True)

    class Meta:
        db_table = 'rbac_role_change_log'
        ordering = ['-timestamp']

    def __str__(self):
        return f'{self.target_user} | {self.old_role} -> {self.new_role}'
