"""API endpoints for notifications (mark as read, list, etc.)."""
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_POST
from .models import Notification


@login_required
def notification_list(request):
    """Show all notifications for the current user."""
    notifications = request.user.notifications.all()[:50]
    return render(request, 'notifications/list.html', {'notifications': notifications})


@login_required
@require_POST
def mark_read(request, notif_id):
    """Mark a single notification as read."""
    Notification.objects.filter(pk=notif_id, recipient=request.user).update(is_read=True)
    return JsonResponse({'ok': True})


@login_required
@require_POST
def mark_all_read(request):
    """Mark all notifications as read."""
    request.user.notifications.filter(is_read=False).update(is_read=True)
    return JsonResponse({'ok': True})


@login_required
def unread_count(request):
    """Return unread count as JSON — used by frontend polling fallback."""
    count = request.user.notifications.filter(is_read=False).count()
    return JsonResponse({'count': count})
