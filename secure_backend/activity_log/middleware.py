"""
Middleware that records page visits to the PageVisit model for analytics.
Only records GET requests to avoid double-counting.
"""
from analytics.models import PageVisit


class ActivityLogMiddleware:
    """Record page visits for analytics dashboard."""

    # Paths to skip (static files, API endpoints, etc.)
    SKIP_PREFIXES = ('/static/', '/media/', '/favicon.ico', '/ws/')

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)

        # Only track GET requests on HTML pages
        if request.method == 'GET' and not any(request.path.startswith(p) for p in self.SKIP_PREFIXES):
            try:
                ip = request.META.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip() or \
                     request.META.get('REMOTE_ADDR', '')
                PageVisit.objects.create(
                    path=request.path[:500],
                    ip_address=ip or '0.0.0.0',
                    user_agent=request.META.get('HTTP_USER_AGENT', '')[:500],
                    user=request.user if request.user.is_authenticated else None,
                )
            except Exception:
                pass  # Never let analytics tracking break the site

        return response
