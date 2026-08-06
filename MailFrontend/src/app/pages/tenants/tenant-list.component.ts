import { Component, OnInit } from '@angular/core';
import { TenantService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import { Tenant } from '../../core/models';

@Component({
  selector: 'app-tenant-list',
  templateUrl: './tenant-list.component.html'
})
export class TenantListComponent implements OnInit {
  tenants: Tenant[] = [];
  loading = true;
  search = '';

  confirmOpen = false;
  pendingDelete: Tenant | null = null;

  constructor(private service: TenantService, private toast: ToastService) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.service.list().subscribe({
      next: (data) => { this.tenants = data; this.loading = false; },
      error: () => { this.loading = false; }
    });
  }

  get filtered(): Tenant[] {
    const term = this.search.trim().toLowerCase();
    if (!term) return this.tenants;
    return this.tenants.filter((t) =>
      t.name.toLowerCase().includes(term) ||
      t.slug.toLowerCase().includes(term) ||
      (t.website_url || '').toLowerCase().includes(term)
    );
  }

  askDelete(tenant: Tenant): void {
    this.pendingDelete = tenant;
    this.confirmOpen = true;
  }

  get deleteMessage(): string {
    const t = this.pendingDelete;
    if (!t) return '';
    return `"${t.name}" will be removed along with its ${t.form_count || 0} form(s), `
      + `SMTP settings and every stored submission.\n\nThis cannot be undone.`;
  }

  confirmDelete(): void {
    if (!this.pendingDelete?.id) return;
    this.service.remove(this.pendingDelete.id).subscribe({
      next: () => {
        this.toast.success('Customer deleted.');
        this.confirmOpen = false;
        this.pendingDelete = null;
        this.load();
      },
      error: () => { this.confirmOpen = false; }
    });
  }
}
