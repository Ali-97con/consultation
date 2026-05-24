"""
ASGI config — supports both HTTP and WebSocket (Django Channels).
"""
import os
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
import notifications.routing

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'secure_crm.settings')

application = ProtocolTypeRouter({
    # Standard HTTP requests
    'http': get_asgi_application(),
    # WebSocket connections — wrapped with auth middleware so consumers know the user
    'websocket': AuthMiddlewareStack(
        URLRouter(notifications.routing.websocket_urlpatterns)
    ),
})
