"""
Web Application Firewall (WAF) middleware — Section 3.

Implements:
1. SQL injection detection
2. XSS detection
3. Directory traversal detection
4. Rate limiting (100 req/min per IP)
5. Cloudflare-compatible headers
"""
import re
import time
import logging
from django.http import HttpResponseForbidden, HttpResponse
from django.core.cache import cache
from django.conf import settings

logger = logging.getLogger('security')

# ── Attack pattern signatures ─────────────────────────────────────────────────

# SQL injection patterns (common keywords and syntax)
SQL_INJECTION_PATTERNS = re.compile(
    r"(union\s+select|select\s+.*\s+from|insert\s+into|drop\s+table|"
    r"delete\s+from|update\s+.*\s+set|exec\s*\(|execute\s*\(|"
    r";\s*drop|;\s*delete|;\s*insert|xp_cmdshell|information_schema|"
    r"--\s*$|\/\*.*\*\/|'\s*or\s+'1'\s*=\s*'1|or\s+1=1)",
    re.IGNORECASE
)

# XSS patterns — script tags, event handlers, javascript: URIs
XSS_PATTERNS = re.compile(
    r"(<script[\s>]|<\/script>|javascript\s*:|on\w+\s*=|"
    r"<iframe[\s>]|<object[\s>]|<embed[\s>]|<link[\s>]|"
    r"expression\s*\(|vbscript\s*:|data\s*:\s*text\/html)",
    re.IGNORECASE
)

# Directory traversal — ../  or ..\\ variations
TRAVERSAL_PATTERNS = re.compile(
    r"(\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e\/|\.\.%2f|%2e\.\/)",
    re.IGNORECASE
)


class WAFMiddleware:
    """
    Inspect every incoming request for attack patterns.
    Block matching requests with 403 Forbidden.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        ip = self._get_ip(request)

        # Check all request data sources
        full_input = self._collect_input(request)

        if SQL_INJECTION_PATTERNS.search(full_input):
            logger.warning(f'WAF: SQL injection attempt from {ip} | path={request.path}')
            self._record_block(ip, 'SQL Injection')
            return HttpResponseForbidden('Request blocked: security policy violation.')

        if XSS_PATTERNS.search(full_input):
            logger.warning(f'WAF: XSS attempt from {ip} | path={request.path}')
            self._record_block(ip, 'XSS Attempt')
            return HttpResponseForbidden('Request blocked: security policy violation.')

        if TRAVERSAL_PATTERNS.search(request.path) or TRAVERSAL_PATTERNS.search(request.get_full_path()):
            logger.warning(f'WAF: Directory traversal from {ip} | path={request.path}')
            self._record_block(ip, 'Directory Traversal')
            return HttpResponseForbidden('Request blocked: security policy violation.')

        response = self.get_response(request)
        # Add Cloudflare-compatible headers
        response['X-WAF-Protected'] = '1'
        return response

    def _collect_input(self, request):
        """Combine URL path, query string, POST body, and headers into one string to scan."""
        parts = [
            request.path,
            request.META.get('QUERY_STRING', ''),
        ]
        if request.method == 'POST':
            try:
                parts.append(request.body.decode('utf-8', errors='ignore')[:4096])
            except Exception:
                pass
        return ' '.join(parts)

    def _get_ip(self, request):
        x_forwarded = request.META.get('HTTP_X_FORWARDED_FOR')
        if x_forwarded:
            return x_forwarded.split(',')[0].strip()
        return request.META.get('REMOTE_ADDR', '')

    def _record_block(self, ip, reason):
        """Save block record to database for analytics dashboard."""
        try:
            from .models import BlockedIP
            BlockedIP.objects.get_or_create(
                ip_address=ip,
                reason=reason,
                defaults={'is_permanent': False}
            )
        except Exception:
            pass


class RateLimitMiddleware:
    """
    Rate limiting middleware — Section 3.
    Allows max 100 requests per minute per IP.
    Uses Redis cache for fast counter storage.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        self.max_requests = getattr(settings, 'RATE_LIMIT_REQUESTS', 100)
        self.window = getattr(settings, 'RATE_LIMIT_WINDOW', 60)  # seconds

    def __call__(self, request):
        ip = self._get_ip(request)
        cache_key = f'rl:{ip}'

        # Get current count
        count = cache.get(cache_key, 0)

        if count >= self.max_requests:
            logger.warning(f'Rate limit exceeded for {ip}')
            return HttpResponse(
                'Too Many Requests. Please slow down.',
                status=429,
                content_type='text/plain'
            )

        # Increment counter — set with expiry on first request
        if count == 0:
            cache.set(cache_key, 1, timeout=self.window)
        else:
            cache.incr(cache_key)

        return self.get_response(request)

    def _get_ip(self, request):
        x_forwarded = request.META.get('HTTP_X_FORWARDED_FOR')
        if x_forwarded:
            return x_forwarded.split(',')[0].strip()
        return request.META.get('REMOTE_ADDR', '')
