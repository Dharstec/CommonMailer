import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormService, SubmissionService, TenantService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import { ContactForm, Pagination, Submission, Tenant } from '../../core/models';

@Component({
  selector: 'app-submission-list',
  templateUrl: './submission-list.component.html'
})
export class SubmissionListComponent implements OnInit {
  submissions: Submission[] = [];
  tenants: Tenant[] = [];
  forms: ContactForm[] = [];
  loading = true;

  pagination: Pagination = { page: 1, limit: 25, total: 0, pages: 0 };

  filters = {
    tenant_id: '' as string | number,
    form_id: '' as string | number,
    status: '',
    search: '',
    from_date: '',
    to_date: ''
  };

  constructor(
    private service: SubmissionService,
    private tenantService: TenantService,
    private formService: FormService,
    private route: ActivatedRoute,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.tenantService.list().subscribe((data) => (this.tenants = data));
    this.formService.list().subscribe((data) => (this.forms = data));

    // Deep links from the dashboard and form cards pre-apply a filter.
    const params = this.route.snapshot.queryParamMap;
    if (params.get('form_id')) this.filters.form_id = params.get('form_id')!;
    if (params.get('status')) this.filters.status = params.get('status')!;

    this.load();
  }

  load(page = 1): void {
    this.loading = true;
    this.service.list({ ...this.filters, page, limit: this.pagination.limit }).subscribe({
      next: (res) => {
        this.submissions = res.data;
        if (res.pagination) this.pagination = res.pagination;
        this.loading = false;
      },
      error: () => { this.loading = false; }
    });
  }

  resetFilters(): void {
    this.filters = { tenant_id: '', form_id: '', status: '', search: '', from_date: '', to_date: '' };
    this.load();
  }

  statusClass(status: string): string {
    if (status === 'sent') return 'badge-ok';
    if (status === 'failed') return 'badge-err';
    if (status === 'spam') return 'badge-mute';
    return 'badge-warn';
  }

  /** First few submitted values, for an at-a-glance table row. */
  summary(row: Submission): string {
    return Object.entries(row.data || {})
      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
      .slice(0, 3)
      .map(([, v]) => (Array.isArray(v) ? v.join(', ') : String(v)))
      .join(' · ');
  }

  resend(row: Submission): void {
    this.service.resend(row.id).subscribe({
      next: () => {
        this.toast.success('Notification resent.');
        this.load(this.pagination.page);
      },
      error: (err) => this.toast.error(err.error?.message || 'Could not resend.')
    });
  }

  exportCsv(): void {
    this.service.exportCsv(this.filters).subscribe((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `submissions-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  get pageNumbers(): number[] {
    const total = this.pagination.pages;
    const current = this.pagination.page;
    const from = Math.max(1, current - 2);
    const to = Math.min(total, from + 4);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
}
