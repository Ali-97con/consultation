"""
Helper functions to create notifications and push them via WebSocket.
Import these throughout the project to trigger notifications.
"""
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import get_user_model
from django.core.mail import send_mail
from django.conf import settings
from .models import Notification

User = get_user_model()
channel_layer = get_channel_layer()


def _push_to_user(user_id, payload):
    """Send a real-time WebSocket notification to a specific user."""
    try:
        async_to_sync(channel_layer.group_send)(
            f'user_{user_id}',
            {'type': 'send_notification', 'data': payload}
        )
    except Exception:
        pass  # WebSocket unavailable — notification is already saved to DB


def _create_and_push(recipient, notif_type, message, action_url=''):
    """Create DB notification record and push it via WebSocket."""
    notif = Notification.objects.create(
        recipient=recipient,
        notification_type=notif_type,
        message=message,
        action_url=action_url,
    )
    _push_to_user(str(recipient.id), {
        'id': str(notif.id),
        'type': notif_type,
        'message': message,
        'action_url': action_url,
        'created_at': notif.created_at.isoformat(),
    })
    return notif


def _get_owners():
    """Return all Owner-role users."""
    return User.objects.filter(role='owner', status='APPROVED')


def _get_owners_and_co_owners():
    """Return Owner and Co-Owner users."""
    return User.objects.filter(role__in=['owner', 'co_owner'], status='APPROVED')


# ── Specific notification triggers ───────────────────────────────────────────

def notify_owner_new_registration(new_user):
    """Notify all Owners when a new member requests access."""
    message = f'New registration request from {new_user.full_name} ({new_user.email}).'
    action_url = f'/accounts/pending/'

    # Email notification to owner
    for owner in _get_owners():
        _create_and_push(owner, Notification.Type.NEW_REGISTRATION, message, action_url)

    # Send email
    try:
        send_mail(
            subject='New Member Registration Request',
            message=f'{message}\n\nApprove or reject at: {settings.ALLOWED_HOSTS[0]}{action_url}',
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[settings.OWNER_EMAIL],
            fail_silently=True,
        )
    except Exception:
        pass


def notify_user_approved(user, approved_by):
    """Notify owner + the approved user."""
    message = f'{user.full_name} has been approved as {user.get_role_display()}.'
    for owner in _get_owners():
        _create_and_push(owner, Notification.Type.MEMBER_APPROVED, message)
    _create_and_push(user, Notification.Type.MEMBER_APPROVED,
                     f'Your account has been approved! Role: {user.get_role_display()}',
                     '/accounts/login/')


def notify_user_rejected(user, rejected_by):
    """Notify owner about rejection."""
    message = f'Registration from {user.full_name} ({user.email}) was rejected.'
    for owner in _get_owners():
        _create_and_push(owner, Notification.Type.MEMBER_REJECTED, message)
    # Email the rejected user
    try:
        send_mail(
            subject='Registration Request — Not Approved',
            message=f'Hello {user.full_name},\n\nUnfortunately your registration request has not been approved.',
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[user.email],
            fail_silently=True,
        )
    except Exception:
        pass


def notify_role_change(user, old_role, new_role, changed_by):
    """Notify owner + affected user of a role change."""
    msg_owner = f'{user.full_name}\'s role changed from {old_role} to {new_role} by {changed_by.full_name}.'
    msg_user = f'Your role has been changed from {old_role} to {new_role}.'
    for owner in _get_owners():
        _create_and_push(owner, Notification.Type.ROLE_CHANGED, msg_owner)
    _create_and_push(user, Notification.Type.ROLE_CHANGED, msg_user)


def notify_owner_login_spike(ip, count):
    """Alert owners of a failed login spike from a single IP."""
    message = f'Security alert: {count} failed login attempts from IP {ip}. IP has been blocked.'
    for owner in _get_owners():
        _create_and_push(owner, Notification.Type.LOGIN_SPIKE, message, '/analytics/dashboard/')
    try:
        send_mail(
            subject='Security Alert: Login Spike Detected',
            message=message,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[settings.OWNER_EMAIL],
            fail_silently=True,
        )
    except Exception:
        pass


def notify_new_report(report):
    """Notify owners and co-owners of a new member report."""
    message = f'New report submitted against {report.reported_user.full_name}: {report.reason}'
    action_url = f'/reports/{report.id}/'
    for staff in _get_owners_and_co_owners():
        _create_and_push(staff, Notification.Type.NEW_REPORT, message, action_url)
    try:
        send_mail(
            subject='New Member Report Submitted',
            message=message,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[settings.OWNER_EMAIL],
            fail_silently=True,
        )
    except Exception:
        pass


def notify_report_resolved(report):
    """Notify reporter and reported user when report is resolved."""
    message = f'Report #{report.id} has been resolved: {report.resolution}.'
    _create_and_push(report.reporter, Notification.Type.REPORT_RESOLVED, message)
    _create_and_push(report.reported_user, Notification.Type.REPORT_RESOLVED, message)


def notify_backup(success, detail=''):
    """Notify owner when backup completes or fails."""
    if success:
        notif_type = Notification.Type.BACKUP_DONE
        message = f'Database backup completed successfully. {detail}'
        subject = 'Backup Completed'
    else:
        notif_type = Notification.Type.BACKUP_FAILED
        message = f'Database backup FAILED. {detail}'
        subject = 'Backup Failed'

    for owner in _get_owners():
        _create_and_push(owner, notif_type, message)
    try:
        send_mail(
            subject=subject,
            message=message,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[settings.OWNER_EMAIL],
            fail_silently=True,
        )
    except Exception:
        pass
