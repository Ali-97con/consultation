"""
Custom password validator enforcing strong password policy (Section 1).
Min 16 chars, must have uppercase, lowercase, digits, and special characters.
"""
import re
from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _


class StrongPasswordValidator:
    """
    Enforce: uppercase, lowercase, digit, and special character requirements.
    Combined with MinimumLengthValidator (min_length=16) in settings.
    """

    def validate(self, password, user=None):
        errors = []
        if not re.search(r'[A-Z]', password):
            errors.append(_('Password must contain at least one uppercase letter (A-Z).'))
        if not re.search(r'[a-z]', password):
            errors.append(_('Password must contain at least one lowercase letter (a-z).'))
        if not re.search(r'\d', password):
            errors.append(_('Password must contain at least one digit (0-9).'))
        if not re.search(r'[!@#$%^&*(),.?":{}|<>_\-+=\[\]\\\/`~;\'"]', password):
            errors.append(_('Password must contain at least one special character (!@#$%^&* etc.).'))
        if errors:
            raise ValidationError(errors)

    def get_help_text(self):
        return _(
            'Your password must be at least 16 characters long and contain '
            'uppercase letters, lowercase letters, digits, and special characters.'
        )
