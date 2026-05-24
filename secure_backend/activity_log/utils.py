"""Convenience function to create activity log entries from anywhere."""
from .models import ActivityLog


def log_action(user, action_type, details=None, ip_address=None):
    """
    Create an ActivityLog entry.
    Call this from views, signals, or management commands.
    """
    ActivityLog.objects.create(
        user=user,
        action_type=action_type,
        details=details or {},
        ip_address=ip_address,
    )
