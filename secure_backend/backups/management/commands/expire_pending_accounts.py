"""
Management command: python manage.py expire_pending_accounts
Expires PENDING accounts older than 48 hours.
Run via cron daily.
"""
from django.core.management.base import BaseCommand
from django.contrib.auth import get_user_model
from django.utils import timezone

User = get_user_model()


class Command(BaseCommand):
    help = 'Mark PENDING accounts older than 48 hours as EXPIRED and delete them.'

    def handle(self, *args, **kwargs):
        users = User.objects.filter(status='PENDING')
        expired_count = 0
        for user in users:
            if user.is_pending_expired():
                self.stdout.write(f'Expiring: {user.email}')
                user.delete()
                expired_count += 1
        self.stdout.write(self.style.SUCCESS(f'Expired {expired_count} accounts.'))
