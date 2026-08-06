import { Component, OnInit } from '@angular/core';
import { FormService, TenantService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import { ContactForm, Tenant } from '../../core/models';

@Component({
  selector: 'app-form-list',
  templateUrl: './form-list.component.html'
})
export class FormListComponent implements OnInit {
  forms: ContactForm[] = [];
  tenants: Tenant[] = [];
  loading = true;
  tenantFilter: number | '' = '';

  confirmOpen = false;
  pendingDelete: ContactForm | null = null;

  copyOpen = false;
  copySource: ContactForm | null = null;
  copyTarget = { tenant_id: null as number | null, form_key: '', name: '' };

  constructor(
    private service: FormService,
    private tenantService: TenantService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.tenantService.list().subscribe((data) => (this.tenants = data));
    this.load();
  }

  load(): void {
    this.loading = true;
    this.service.list(this.tenantFilter === '' ? undefined : Number(this.tenantFilter)).subscribe({
      next: (data) => { this.forms = data; this.loading = false; },
      error: () => { this.loading = false; }
    });
  }

  copyLink(form: ContactForm): void {
    const url = form.links?.submit_url;
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => this.toast.success('Endpoint copied.'),
      () => this.toast.error('Could not copy. Select the text and copy manually.')
    );
  }

  askDelete(form: ContactForm): void {
    this.pendingDelete = form;
    this.confirmOpen = true;
  }

  get deleteMessage(): string {
    const f = this.pendingDelete;
    if (!f) return '';
    return `"${f.name}" and its ${f.submission_count || 0} stored submission(s) will be deleted.\n\n`
      + `Any website still showing this form will stop working immediately.`;
  }

  confirmDelete(): void {
    if (!this.pendingDelete?.id) return;
    this.service.remove(this.pendingDelete.id).subscribe({
      next: () => {
        this.toast.success('Form deleted.');
        this.confirmOpen = false;
        this.load();
      },
      error: () => { this.confirmOpen = false; }
    });
  }

  openCopy(form: ContactForm): void {
    this.copySource = form;
    this.copyTarget = {
      tenant_id: null,
      form_key: `${form.form_key}-copy`,
      name: `${form.name} (copy)`
    };
    this.copyOpen = true;
  }

  submitCopy(): void {
    if (!this.copySource?.id || !this.copyTarget.tenant_id) {
      this.toast.error('Choose which customer the copy belongs to.');
      return;
    }
    this.service.duplicate(this.copySource.id, {
      tenant_id: this.copyTarget.tenant_id,
      form_key: this.copyTarget.form_key,
      name: this.copyTarget.name
    }).subscribe({
      next: (res) => {
        this.toast.success(res.message || 'Form copied.');
        this.copyOpen = false;
        this.load();
      },
      error: (err) => this.toast.error(err.error?.message || 'Could not copy the form.')
    });
  }
}
