"""
RBAC decorators for view-level permission enforcement.
ALWAYS enforced on the server side — never trust client-side checks alone (Section 6).
"""
from functools import wraps
from django.shortcuts import redirect
from django.contrib import messages
from django.conf import settings


def role_required(*allowed_roles):
    """
    Decorator that restricts a view to users with specific roles.
    Usage: @role_required('owner', 'co_owner')
    """
    def decorator(view_func):
        @wraps(view_func)
        def _wrapped(request, *args, **kwargs):
            if not request.user.is_authenticated:
                return redirect(settings.LOGIN_URL)
            if request.user.role not in allowed_roles:
                messages.error(request, 'You do not have permission to access this page.')
                return redirect(settings.LOGIN_REDIRECT_URL)
            if request.user.status != request.user.Status.APPROVED:
                messages.error(request, 'Your account is not active.')
                return redirect('accounts:login')
            return view_func(request, *args, **kwargs)
        return _wrapped
    return decorator


def owner_required(view_func):
    """Shortcut: owner-only view."""
    return role_required('owner')(view_func)


def co_owner_or_above(view_func):
    """Shortcut: owner or co_owner."""
    return role_required('owner', 'co_owner')(view_func)


def editor_or_above(view_func):
    """Shortcut: owner, co_owner, or editor."""
    return role_required('owner', 'co_owner', 'editor')(view_func)
