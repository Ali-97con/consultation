"""Report management views."""
from django.contrib.auth.decorators import login_required
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib import messages
from django.utils import timezone
from django.contrib.auth import get_user_model

from rbac.decorators import co_owner_or_above
from activity_log.utils import log_action
from notifications.utils import notify_new_report, notify_report_resolved
from .models import Report
from .forms import ReportForm

User = get_user_model()


def _get_ip(request):
    xff = request.META.get('HTTP_X_FORWARDED_FOR')
    return xff.split(',')[0].strip() if xff else request.META.get('REMOTE_ADDR', '')


@login_required
def submit_report(request):
    """Any member can submit a report."""
    if request.method == 'POST':
        form = ReportForm(request.user, request.POST)
        if form.is_valid():
            report = form.save(commit=False)
            report.reporter = request.user
            report.save()
            notify_new_report(report)
            log_action(request.user, 'report_submitted',
                       {'report_id': str(report.id), 'against': str(report.reported_user_id)},
                       _get_ip(request))
            messages.success(request, 'Your report has been submitted.')
            return redirect('reports:list')
    else:
        form = ReportForm(request.user)
    return render(request, 'reports/submit.html', {'form': form})


@login_required
def report_list(request):
    """
    Owners/Co-Owners: all reports.
    Others: own submitted reports only.
    """
    user = request.user
    if user.role in ('owner', 'co_owner'):
        reports = Report.objects.select_related('reporter', 'reported_user').all()
    else:
        reports = Report.objects.filter(reporter=user).select_related('reported_user')
    return render(request, 'reports/list.html', {'reports': reports})


@login_required
def report_detail(request, report_id):
    """View and resolve a report (Owner/Co-Owner only for resolution)."""
    user = request.user
    report = get_object_or_404(Report, pk=report_id)

    # Access control: reporter can view own report, staff can view all
    if report.reporter != user and user.role not in ('owner', 'co_owner'):
        messages.error(request, 'Access denied.')
        return redirect('reports:list')

    if request.method == 'POST' and user.role in ('owner', 'co_owner'):
        action = request.POST.get('action')
        resolution_text = request.POST.get('resolution', '').strip()
        reported = report.reported_user

        if action == 'warn':
            report.status = Report.Status.WARNED
        elif action == 'suspend' and reported:
            reported.status = User.Status.SUSPENDED
            reported.save(update_fields=['status'])
            report.status = Report.Status.SUSPENDED
            log_action(user, 'member_suspended', {'target': str(reported.id)}, _get_ip(request))
        elif action == 'delete' and reported:
            log_action(user, 'member_deleted', {'target': str(reported.id)}, _get_ip(request))
            reported.delete()
            report.reported_user = None
            report.status = Report.Status.DELETED
        elif action == 'dismiss':
            report.status = Report.Status.DISMISSED

        report.resolution = resolution_text
        report.resolved_by = user
        report.resolved_at = timezone.now()
        report.save()
        notify_report_resolved(report)
        messages.success(request, f'Report has been {action}ed.')
        return redirect('reports:list')

    return render(request, 'reports/detail.html', {'report': report})
