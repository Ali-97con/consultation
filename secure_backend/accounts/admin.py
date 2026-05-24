from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import User, LoginAttempt


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ['email', 'full_name', 'role', 'status', 'date_joined']
    list_filter = ['role', 'status']
    search_fields = ['email', 'full_name']
    ordering = ['-date_joined']
    fieldsets = (
        (None, {'fields': ('email', 'password')}),
        ('Personal', {'fields': ('full_name',)}),
        ('Role & Status', {'fields': ('role', 'status', 'approved_by', 'approved_at')}),
        ('2FA', {'fields': ('totp_enabled', 'totp_secret')}),
        ('Permissions', {'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions')}),
    )
    add_fieldsets = (
        (None, {
            'classes': ('wide',),
            'fields': ('email', 'full_name', 'password1', 'password2', 'role', 'status'),
        }),
    )


@admin.register(LoginAttempt)
class LoginAttemptAdmin(admin.ModelAdmin):
    list_display = ['ip_address', 'email_tried', 'was_successful', 'timestamp', 'blocked_until']
    list_filter = ['was_successful']
    search_fields = ['ip_address', 'email_tried']
    ordering = ['-timestamp']
