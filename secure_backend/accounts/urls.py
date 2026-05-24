from django.urls import path
from . import views

app_name = 'accounts'

urlpatterns = [
    path('register/', views.register_view, name='register'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),
    path('2fa/setup/', views.setup_2fa_view, name='setup_2fa'),
    path('2fa/verify/', views.verify_2fa_view, name='verify_2fa'),
    path('pending/', views.pending_users_view, name='pending_users'),
    path('approve/<uuid:user_id>/', views.approve_user_view, name='approve_user'),
    path('reject/<uuid:user_id>/', views.reject_user_view, name='reject_user'),
]
