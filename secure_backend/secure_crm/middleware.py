"""
Custom middleware for security headers not covered by Django's built-in settings.
Implements Section 13 requirements.
"""


class SecurityHeadersMiddleware:
    """Add security headers to every response."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        # Prevent browsers from MIME-sniffing (already set via SECURE_CONTENT_TYPE_NOSNIFF but explicit here)
        response['X-Content-Type-Options'] = 'nosniff'
        # Control how much referrer info is sent
        response['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        # Restrict browser features (camera, microphone, geolocation, etc.)
        response['Permissions-Policy'] = (
            'camera=(), microphone=(), geolocation=(), '
            'payment=(), usb=(), magnetometer=(), gyroscope=()'
        )
        # Cloudflare-compatible cache control header
        response['Cache-Control'] = 'no-store, no-cache, must-revalidate, private'
        return response
