from django.urls import path
from . import views

app_name = 'activity_log'

urlpatterns = [
    path('', views.log_list, name='list'),
    path('export/', views.export_log_csv, name='export'),
]
