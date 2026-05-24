"""Activity log views with role-based access control."""
import csv
from django.contrib.auth.decorators import login_required
from django.shortcuts import render, get_object_or_404
from django.http import HttpResponse
from django.contrib.auth import get_user_model
from .models import ActivityLog

User = get_user_model()


@login_required
def log_list(request):
    """
    Show activity log.
    - Owner: all logs
    - Co-Owner: logs for Editors and Viewers only
    - Others: own logs only
    """
    user = request.user
    logs = ActivityLog.objects.select_related('user')

    if user.is_owner:
        # Filter by target user if specified
        target_id = request.GET.get('user_id')
        if target_id:
            logs = logs.filter(user__id=target_id)
    elif user.is_co_owner:
        # Co-Owner can see logs for Editors and Viewers only
        logs = logs.filter(user__role__in=['editor', 'viewer'])
    else:
        # Regular users see only their own logs
        logs = logs.filter(user=user)

    # Filters from query params
    action_type = request.GET.get('action_type')
    date_from = request.GET.get('date_from')
    date_to = request.GET.get('date_to')

    if action_type:
        logs = logs.filter(action_type=action_type)
    if date_from:
        logs = logs.filter(created_at__date__gte=date_from)
    if date_to:
        logs = logs.filter(created_at__date__lte=date_to)

    logs = logs.order_by('-created_at')[:500]

    return render(request, 'activity_log/list.html', {
        'logs': logs,
        'action_types': ActivityLog.ActionType.choices,
    })


@login_required
def export_log_csv(request):
    """Export activity logs as CSV (Owner only)."""
    if not request.user.is_owner:
        return HttpResponse('Access denied.', status=403)

    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename="activity_log.csv"'

    writer = csv.writer(response)
    writer.writerow(['Timestamp', 'User', 'Action', 'IP', 'Details'])

    for log in ActivityLog.objects.select_related('user').order_by('-created_at')[:5000]:
        writer.writerow([
            log.created_at.isoformat(),
            log.user.email if log.user else 'system',
            log.action_type,
            log.ip_address or '',
            str(log.details),
        ])

    return response
