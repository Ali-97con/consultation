import html
from django import forms
from django.contrib.auth import get_user_model
from .models import Report

User = get_user_model()


class ReportForm(forms.ModelForm):
    class Meta:
        model = Report
        fields = ['reported_user', 'reason', 'description']

    def __init__(self, reporter, *args, **kwargs):
        self.reporter = reporter
        super().__init__(*args, **kwargs)
        # Cannot report the Owner
        self.fields['reported_user'].queryset = User.objects.filter(
            status='APPROVED'
        ).exclude(role='owner').exclude(id=reporter.id)

    def clean(self):
        cleaned = super().clean()
        # Max 3 open reports per reporter
        open_count = Report.objects.filter(reporter=self.reporter, status='OPEN').count()
        if open_count >= 3:
            raise forms.ValidationError('You already have 3 open reports. Wait for them to be resolved.')
        # Sanitize description
        desc = cleaned.get('description', '')
        cleaned['description'] = html.escape(desc.strip())
        return cleaned
