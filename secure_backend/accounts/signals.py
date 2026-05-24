"""
Django signals for account-related events.
- Auto-expire PENDING accounts older than 48 hours (called periodically)
- Send welcome/rejection emails
"""
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.contrib.auth import get_user_model
from django.core.mail import send_mail
from django.conf import settings
from django.template.loader import render_to_string

User = get_user_model()


@receiver(post_save, sender=User)
def send_status_email(sender, instance, created, **kwargs):
    """Send welcome email when a user is approved."""
    if not created and instance.status == User.Status.APPROVED:
        try:
            send_mail(
                subject='Your account has been approved — Welcome!',
                message=f'Hello {instance.full_name},\n\nYour account has been approved. '
                        f'You can now log in at your dashboard.\n\nRole: {instance.get_role_display()}',
                from_email=settings.DEFAULT_FROM_EMAIL,
                recipient_list=[instance.email],
                fail_silently=True,
            )
        except Exception:
            pass  # Non-critical; already notified via dashboard
