"""
Custom authentication backend that authenticates using email + password
and enforces the account status check (only APPROVED accounts can log in).
"""
from django.contrib.auth.backends import ModelBackend
from django.contrib.auth import get_user_model

User = get_user_model()


class EmailBackend(ModelBackend):
    """Authenticate with email instead of username."""

    def authenticate(self, request, email=None, password=None, username=None, **kwargs):
        # Support both email= and username= keyword for compatibility
        email = email or username
        if not email:
            return None
        try:
            user = User.objects.get(email=email.lower())
        except User.DoesNotExist:
            return None

        if not user.check_password(password):
            return None

        # Only APPROVED users may authenticate
        if not user.can_login():
            return None

        return user

    def get_user(self, user_id):
        try:
            return User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return None
