"""
Owner-only analytics dashboard.
All queries use Django ORM — no third-party analytics tools (Section 8).
Auto-refreshes every 60 seconds via meta refresh.
"""
import csv
from datetime import timedelta
from django.utils import timezone
from django.shortcuts import render
from django.http import HttpResponse
from django.contrib.auth import get_user_model
from django.db.models import Count
from django.db.models.functions import TruncHour, TruncDate

from rbac.decorators import owner_required
from activity_log.models import ActivityLog
from accounts.models import LoginAttempt
from waf.models import BlockedIP
from .models import PageVisit

User = get_user_model()


@owner_required
def dashboard(request):
    """
    Full analytics dashboard — visible to Owner only.
    Computes all stats server-side using Django ORM.
    """
    now = timezone.now()
    today = now.date()
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    # ── Member statistics ─────────────────────────────────────────────────────
    users = User.objects.all()
    member_stats = {
        'total': users.count(),
        'by_role': dict(users.values_list('role').annotate(c=Count('id')).values_list('role', 'c')),
        'pending': users.filter(status='PENDING').count(),
        'suspended': users.filter(status='SUSPENDED').count(),
        'rejected': users.filter(status='REJECTED').count(),
        'new_this_week': users.filter(date_joined__gte=week_ago).count(),
        'new_this_month': users.filter(date_joined__gte=month_ago).count(),
    }

    # Most active members (by action count)
    most_active = (
        ActivityLog.objects.filter(created_at__gte=week_ago)
        .exclude(user__isnull=True)
        .values('user__full_name', 'user__email')
        .annotate(action_count=Count('id'))
        .order_by('-action_count')[:10]
    )

    # ── Site activity ─────────────────────────────────────────────────────────
    visits = PageVisit.objects
    site_stats = {
        'today': visits.filter(visited_at__date=today).count(),
        'this_week': visits.filter(visited_at__gte=week_ago).count(),
        'this_month': visits.filter(visited_at__gte=month_ago).count(),
        'unique_today': visits.filter(visited_at__date=today).values('ip_address').distinct().count(),
    }

    # Most visited pages
    top_pages = (
        visits.filter(visited_at__gte=week_ago)
        .values('path').annotate(c=Count('id')).order_by('-c')[:10]
    )

    # Peak usage hours (today)
    hourly = (
        visits.filter(visited_at__date=today)
        .annotate(hour=TruncHour('visited_at'))
        .values('hour').annotate(c=Count('id')).order_by('hour')
    )
    hourly_data = {str(row['hour'].hour): row['c'] for row in hourly}

    # ── Security overview ─────────────────────────────────────────────────────
    failed_24h = LoginAttempt.objects.filter(
        was_successful=False, timestamp__gte=now - timedelta(hours=24)
    ).count()
    failed_7d = LoginAttempt.objects.filter(
        was_successful=False, timestamp__gte=week_ago
    ).count()

    blocked_ips = BlockedIP.objects.order_by('-blocked_at')[:20]

    # Active sessions (approximate: users with activity in last 30 min)
    active_sessions = ActivityLog.objects.filter(
        created_at__gte=now - timedelta(minutes=30)
    ).values('user').distinct().count()

    context = {
        'member_stats': member_stats,
        'most_active': most_active,
        'site_stats': site_stats,
        'top_pages': top_pages,
        'hourly_data': hourly_data,
        'failed_24h': failed_24h,
        'failed_7d': failed_7d,
        'blocked_ips': blocked_ips,
        'active_sessions': active_sessions,
        'now': now,
    }
    return render(request, 'analytics/dashboard.html', context)


@owner_required
def export_stats_csv(request):
    """Export member statistics as CSV (Section 8)."""
    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename="stats_export.csv"'

    writer = csv.writer(response)
    writer.writerow(['Email', 'Full Name', 'Role', 'Status', 'Date Joined'])
    for user in User.objects.all().order_by('date_joined'):
        writer.writerow([user.email, user.full_name, user.role, user.status, user.date_joined])

    return response
