"""
Django Channels WebSocket consumer.
Each authenticated user connects to their own group channel.
"""
import json
from channels.generic.websocket import AsyncWebsocketConsumer


class NotificationConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for real-time notifications.
    Each user subscribes to their own private channel group.
    """

    async def connect(self):
        """Accept connection only for authenticated users."""
        user = self.scope.get('user')
        if not user or not user.is_authenticated:
            await self.close()
            return

        self.group_name = f'user_{user.id}'
        # Join user's private group
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        """Leave the group on disconnect."""
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def send_notification(self, event):
        """Receive notification from group and forward to WebSocket client."""
        await self.send(text_data=json.dumps(event['data']))
