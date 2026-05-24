"""
Management command: python manage.py backup_db
Runs a PostgreSQL dump, optionally uploads to S3, keeps last 4 backups.
Sends email/notification on success or failure.
(Section 11)
"""
import os
import subprocess
import datetime
from pathlib import Path
from django.core.management.base import BaseCommand
from django.conf import settings
from activity_log.utils import log_action
from notifications.utils import notify_backup


class Command(BaseCommand):
    help = 'Create a PostgreSQL database backup and optionally upload to S3.'

    def handle(self, *args, **kwargs):
        timestamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        backup_dir = Path(settings.BACKUP_LOCAL_PATH)
        backup_dir.mkdir(parents=True, exist_ok=True)
        filename = f'backup_{timestamp}.sql.gz'
        filepath = backup_dir / filename

        db = settings.DATABASES['default']
        env = os.environ.copy()
        env['PGPASSWORD'] = db['PASSWORD']

        # Build pg_dump command with gzip compression
        cmd = [
            'pg_dump',
            '-h', db['HOST'],
            '-p', str(db['PORT']),
            '-U', db['USER'],
            '-d', db['NAME'],
            '--format=custom',
            '--file', str(filepath),
        ]

        try:
            self.stdout.write(f'Starting backup: {filename}')
            result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)

            if result.returncode != 0:
                raise RuntimeError(f'pg_dump failed: {result.stderr}')

            self.stdout.write(self.style.SUCCESS(f'Backup saved: {filepath}'))

            # Upload to S3 if configured
            if getattr(settings, 'USE_S3_BACKUP', False):
                self._upload_to_s3(filepath, filename)

            # Keep only last 4 backups locally
            self._rotate_backups(backup_dir, keep=4)

            # Notify owner of success
            notify_backup(success=True, detail=f'File: {filename}')
            log_action(None, 'backup_run', {'status': 'success', 'file': filename})

        except Exception as e:
            self.stderr.write(self.style.ERROR(f'Backup FAILED: {e}'))
            notify_backup(success=False, detail=str(e))
            log_action(None, 'backup_run', {'status': 'failed', 'error': str(e)})

    def _upload_to_s3(self, filepath, filename):
        """Upload backup file to AWS S3."""
        import boto3
        s3 = boto3.client('s3',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
        )
        bucket = os.environ.get('AWS_STORAGE_BUCKET_NAME', 'my-backups')
        s3.upload_file(str(filepath), bucket, f'db-backups/{filename}')
        self.stdout.write(f'Uploaded to S3: s3://{bucket}/db-backups/{filename}')

    def _rotate_backups(self, backup_dir, keep=4):
        """Delete oldest backups, keeping only `keep` most recent."""
        backups = sorted(backup_dir.glob('backup_*.sql*'), key=lambda f: f.stat().st_mtime)
        to_delete = backups[:-keep] if len(backups) > keep else []
        for old in to_delete:
            old.unlink()
            self.stdout.write(f'Deleted old backup: {old.name}')
