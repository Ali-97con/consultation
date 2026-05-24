from django.urls import path
from . import views

app_name = 'reports'

urlpatterns = [
    path('', views.report_list, name='list'),
    path('submit/', views.submit_report, name='submit'),
    path('<uuid:report_id>/', views.report_detail, name='detail'),
]
