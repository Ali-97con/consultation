"""
Registration and login forms with server-side validation and sanitization.
All inputs are sanitized before processing (Section 4).
"""
import re
import html
import pyotp
from django import forms
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError

User = get_user_model()


def sanitize_input(value):
    """
    Sanitize text input: strip leading/trailing whitespace and escape HTML entities.
    Prevents XSS from stored content (Section 3 & 4).
    """
    if isinstance(value, str):
        return html.escape(value.strip())
    return value


class RegistrationForm(forms.ModelForm):
    """
    Registration form.
    - Server-side validation of all fields
    - Password confirmation
    - Strong password enforced via validators
    """
    password1 = forms.CharField(
        label='Password',
        widget=forms.PasswordInput,
        help_text='Min 16 characters, must include uppercase, lowercase, number, and special character.'
    )
    password2 = forms.CharField(label='Confirm Password', widget=forms.PasswordInput)

    class Meta:
        model = User
        fields = ['full_name', 'email']

    def clean_full_name(self):
        name = self.cleaned_data.get('full_name', '')
        # Only allow letters, spaces, hyphens, apostrophes
        if not re.match(r"^[A-Za-z؀-ۿ\s'\-]{2,150}$", name):
            raise ValidationError('Name may only contain letters, spaces, hyphens, and apostrophes.')
        return sanitize_input(name)

    def clean_email(self):
        email = self.cleaned_data.get('email', '').lower().strip()
        if User.objects.filter(email=email).exists():
            raise ValidationError('An account with this email already exists.')
        return email

    def clean_password1(self):
        password = self.cleaned_data.get('password1')
        validate_password(password)  # Runs all validators from settings.AUTH_PASSWORD_VALIDATORS
        return password

    def clean(self):
        cleaned = super().clean()
        p1 = cleaned.get('password1')
        p2 = cleaned.get('password2')
        if p1 and p2 and p1 != p2:
            raise ValidationError({'password2': 'Passwords do not match.'})
        return cleaned

    def save(self, commit=True):
        user = super().save(commit=False)
        user.set_password(self.cleaned_data['password1'])
        user.status = User.Status.PENDING  # New accounts start as PENDING
        if commit:
            user.save()
        return user


class LoginForm(forms.Form):
    """Login form — email + password only. 2FA handled separately."""
    email = forms.EmailField()
    password = forms.CharField(widget=forms.PasswordInput)

    def clean_email(self):
        return self.cleaned_data['email'].lower().strip()


class TwoFactorVerifyForm(forms.Form):
    """Form to verify a TOTP code from authenticator app."""
    token = forms.CharField(
        label='Authentication Code',
        max_length=6,
        min_length=6,
        widget=forms.TextInput(attrs={'placeholder': '6-digit code', 'autocomplete': 'off'}),
    )

    def __init__(self, user, *args, **kwargs):
        self.user = user
        super().__init__(*args, **kwargs)

    def clean_token(self):
        token = self.cleaned_data.get('token', '').strip()
        if not token.isdigit():
            raise ValidationError('Token must be a 6-digit number.')
        # Verify the TOTP token against the user's secret
        totp = pyotp.TOTP(self.user.totp_secret)
        if not totp.verify(token, valid_window=1):  # Allow 1 period (30s) drift
            raise ValidationError('Invalid or expired authentication code.')
        return token


class ApproveUserForm(forms.Form):
    """Owner form to approve a pending user and assign their role."""
    role = forms.ChoiceField(choices=[
        ('co_owner', 'Co-Owner'),
        ('editor', 'Editor'),
        ('viewer', 'Viewer'),
    ])
