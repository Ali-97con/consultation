"""
Authentication views:
- Registration (creates PENDING account, notifies owner)
- Login (with IP blocking + 2FA)
- 2FA setup and verification
- Owner approval/rejection flow
"""
import io
import pyotp
import qrcode
import base64
import logging
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.views.decorators.http import require_POST
from django.contrib import messages
from django.utils import timezone
from django.conf import settings
from django.http import HttpResponse

from .forms import RegistrationForm, LoginForm, TwoFactorVerifyForm, ApproveUserForm
from .models import LoginAttempt
from activity_log.utils import log_action
from notifications.utils import (
    notify_owner_new_registration,
    notify_user_approved,
    notify_user_rejected,
)

User = get_user_model()
logger = logging.getLogger('security')


def _get_client_ip(request):
    """Extract real client IP, respecting X-Forwarded-For from Cloudflare/proxy."""
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        return x_forwarded_for.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR', '127.0.0.1')


def register_view(request):
    """
    Step 1 of member access flow.
    Creates account with PENDING status and notifies Owner.
    """
    if request.method == 'POST':
        form = RegistrationForm(request.POST)
        if form.is_valid():
            user = form.save()
            # Notify owner immediately
            notify_owner_new_registration(user)
            log_action(None, 'registration_request', {'email': user.email}, _get_client_ip(request))
            messages.success(request, 'Your registration request has been submitted. You will receive an email once reviewed.')
            return redirect('accounts:login')
    else:
        form = RegistrationForm()
    return render(request, 'accounts/register.html', {'form': form})


def login_view(request):
    """
    Login with IP blocking and 2FA support.
    - Checks IP block before attempting authentication
    - Records success/failure for rate tracking
    - Redirects to 2FA verification if enabled
    """
    ip = _get_client_ip(request)

    # Check if IP is currently blocked (Section 1)
    if LoginAttempt.is_ip_blocked(ip):
        logger.warning(f'Blocked IP {ip} attempted login')
        messages.error(request, 'Too many failed attempts. Please try again in 15 minutes.')
        return render(request, 'accounts/login.html', {'form': LoginForm(), 'blocked': True})

    if request.method == 'POST':
        form = LoginForm(request.POST)
        if form.is_valid():
            email = form.cleaned_data['email']
            password = form.cleaned_data['password']

            user = authenticate(request, email=email, password=password)

            if user is None:
                # Record failure — may trigger block
                LoginAttempt.record_failure(ip, email)
                logger.warning(f'Failed login for {email} from {ip}')
                messages.error(request, 'Invalid credentials or account not approved.')
                return render(request, 'accounts/login.html', {'form': form})

            # Credentials valid — check 2FA
            if user.totp_enabled:
                # Store user ID in session temporarily (not fully logged in yet)
                request.session['pre_2fa_user_id'] = str(user.id)
                request.session['pre_2fa_ip'] = ip
                LoginAttempt.record_success(ip, email)
                return redirect('accounts:verify_2fa')

            # No 2FA — complete login
            login(request, user)
            LoginAttempt.record_success(ip, email)
            log_action(user, 'login', {'ip': ip}, ip)
            logger.info(f'Successful login: {email} from {ip}')
            return redirect(settings.LOGIN_REDIRECT_URL)
    else:
        form = LoginForm()

    return render(request, 'accounts/login.html', {'form': form})


def verify_2fa_view(request):
    """
    Second step of login: verify TOTP token from authenticator app.
    User is only fully logged in after this step.
    """
    user_id = request.session.get('pre_2fa_user_id')
    if not user_id:
        return redirect('accounts:login')

    user = get_object_or_404(User, pk=user_id)
    ip = request.session.get('pre_2fa_ip', _get_client_ip(request))

    if request.method == 'POST':
        form = TwoFactorVerifyForm(user, request.POST)
        if form.is_valid():
            # TOTP verified — complete login
            del request.session['pre_2fa_user_id']
            login(request, user)
            log_action(user, 'login_2fa', {'ip': ip}, ip)
            return redirect(settings.LOGIN_REDIRECT_URL)
        else:
            LoginAttempt.record_failure(ip, user.email)
            messages.error(request, 'Invalid authentication code.')
    else:
        form = TwoFactorVerifyForm(user)

    return render(request, 'accounts/verify_2fa.html', {'form': form})


@login_required
def setup_2fa_view(request):
    """
    Allow user to enable TOTP 2FA.
    Generates a secret, shows QR code, and confirms with a test token.
    """
    user = request.user

    if request.method == 'POST':
        secret = request.session.get('totp_setup_secret')
        if not secret:
            messages.error(request, 'Setup session expired. Please try again.')
            return redirect('accounts:setup_2fa')

        token = request.POST.get('token', '').strip()
        totp = pyotp.TOTP(secret)
        if totp.verify(token, valid_window=1):
            user.totp_secret = secret
            user.totp_enabled = True
            user.save(update_fields=['totp_secret', 'totp_enabled'])
            del request.session['totp_setup_secret']
            log_action(user, '2fa_enabled', {}, _get_client_ip(request))
            messages.success(request, '2FA has been enabled successfully.')
            return redirect(settings.LOGIN_REDIRECT_URL)
        else:
            messages.error(request, 'Invalid token. Please scan the QR code again.')

    # Generate new secret and QR code
    secret = pyotp.random_base32()
    request.session['totp_setup_secret'] = secret

    totp_uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=user.email,
        issuer_name=settings.TOTP_ISSUER_NAME
    )

    # Generate QR code as base64 image
    qr = qrcode.make(totp_uri)
    buf = io.BytesIO()
    qr.save(buf, format='PNG')
    qr_b64 = base64.b64encode(buf.getvalue()).decode()

    return render(request, 'accounts/setup_2fa.html', {
        'qr_b64': qr_b64,
        'secret': secret,
    })


@login_required
def logout_view(request):
    """Logout and record action in activity log."""
    ip = _get_client_ip(request)
    log_action(request.user, 'logout', {'ip': ip}, ip)
    logout(request)
    return redirect('accounts:login')


# ── Owner-only: Approve / Reject members ─────────────────────────────────────

@login_required
def pending_users_view(request):
    """List all pending registration requests (Owner only)."""
    if not request.user.is_owner:
        messages.error(request, 'Access denied.')
        return redirect(settings.LOGIN_REDIRECT_URL)

    pending = User.objects.filter(status=User.Status.PENDING).order_by('date_joined')
    return render(request, 'accounts/pending_users.html', {'pending': pending})


@login_required
@require_POST
def approve_user_view(request, user_id):
    """Owner approves a pending user and assigns a role."""
    if not request.user.is_owner:
        messages.error(request, 'Access denied.')
        return redirect(settings.LOGIN_REDIRECT_URL)

    user = get_object_or_404(User, pk=user_id, status=User.Status.PENDING)
    form = ApproveUserForm(request.POST)

    if form.is_valid():
        role = form.cleaned_data['role']
        user.role = role
        user.status = User.Status.APPROVED
        user.approved_at = timezone.now()
        user.approved_by = request.user
        user.save(update_fields=['role', 'status', 'approved_at', 'approved_by'])

        notify_user_approved(user, request.user)
        log_action(request.user, 'user_approved', {'target_user': str(user.id), 'role': role}, _get_client_ip(request))
        messages.success(request, f'{user.full_name} has been approved as {role}.')
    else:
        messages.error(request, 'Please select a role.')

    return redirect('accounts:pending_users')


@login_required
@require_POST
def reject_user_view(request, user_id):
    """Owner rejects a pending user — account is deleted."""
    if not request.user.is_owner:
        messages.error(request, 'Access denied.')
        return redirect(settings.LOGIN_REDIRECT_URL)

    user = get_object_or_404(User, pk=user_id, status=User.Status.PENDING)
    email = user.email
    name = user.full_name

    notify_user_rejected(user, request.user)
    log_action(request.user, 'user_rejected', {'email': email}, _get_client_ip(request))
    user.delete()

    messages.success(request, f'Registration from {name} has been rejected and account deleted.')
    return redirect('accounts:pending_users')
