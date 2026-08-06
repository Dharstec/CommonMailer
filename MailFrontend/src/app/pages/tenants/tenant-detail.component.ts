import { Component, OnInit } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TenantService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import { Tenant } from '../../core/models';

/** Common providers, offered as one-click presets so ports and TLS are right. */
const SMTP_PRESETS: Record<string, { host: string; port: number; secure: boolean; note: string }> = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false, note: 'Requires a Google App Password, not the account password.' },
  zoho: { host: 'smtp.zoho.in', port: 587, secure: false, note: 'Use an app-specific password if 2FA is enabled.' },
  office365: { host: 'smtp.office365.com', port: 587, secure: false, note: 'SMTP AUTH must be enabled for the mailbox.' },
  hostinger: { host: 'smtp.hostinger.com', port: 465, secure: true, note: 'Implicit TLS on 465.' },
  godaddy: { host: 'smtpout.secureserver.net', port: 465, secure: true, note: 'Implicit TLS on 465.' }
};

@Component({
  selector: 'app-tenant-detail',
  templateUrl: './tenant-detail.component.html'
})
export class TenantDetailComponent implements OnInit {
  tenantId: number | null = null;
  loading = false;
  saving = false;
  savingSmtp = false;
  testing = false;
  smtpConfigured = false;
  smtpVerifiedAt: string | null = null;
  testEmail = '';
  presetNote = '';

  readonly presets = Object.keys(SMTP_PRESETS);

  readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    slug: ['', [Validators.required, Validators.pattern(/^[a-z0-9][a-z0-9-]*$/)]],
    website_url: [''],
    contact_email: [''],
    notes: [''],
    is_active: [true]
  });

  readonly smtpForm = this.fb.group({
    host: ['', Validators.required],
    port: [587, [Validators.required, Validators.min(1), Validators.max(65535)]],
    secure: [false],
    username: ['', Validators.required],
    password: [''],
    from_name: ['', Validators.required],
    from_email: ['', [Validators.required, Validators.email]],
    reply_to: [''],
    is_active: [true]
  });

  constructor(
    private fb: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private service: TenantService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    const param = this.route.snapshot.paramMap.get('id');
    if (param && param !== 'new') {
      this.tenantId = Number(param);
      this.load();
    } else {
      // A new customer needs a password before anything can be sent.
      this.smtpForm.controls.password.addValidators(Validators.required);
    }
  }

  get isNew(): boolean { return this.tenantId === null; }

  private load(): void {
    this.loading = true;
    this.service.get(this.tenantId!).subscribe({
      next: (tenant: Tenant) => {
        this.form.patchValue({
          name: tenant.name,
          slug: tenant.slug,
          website_url: tenant.website_url || '',
          contact_email: tenant.contact_email || '',
          notes: tenant.notes || '',
          is_active: tenant.is_active
        });

        if (tenant.smtp) {
          this.smtpConfigured = true;
          this.smtpVerifiedAt = tenant.smtp.verified_at || null;
          this.smtpForm.patchValue({
            host: tenant.smtp.host,
            port: tenant.smtp.port,
            secure: tenant.smtp.secure,
            username: tenant.smtp.username,
            from_name: tenant.smtp.from_name,
            from_email: tenant.smtp.from_email,
            reply_to: tenant.smtp.reply_to || '',
            is_active: tenant.smtp.is_active
          });
        }
        this.loading = false;
      },
      error: () => { this.loading = false; }
    });
  }

  /** Derives a URL-safe slug from the customer name as it is typed. */
  onNameChange(): void {
    if (!this.isNew) return;
    const slug = (this.form.value.name || '')
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    this.form.patchValue({ slug }, { emitEvent: false });
  }

  applyPreset(key: string): void {
    const preset = SMTP_PRESETS[key];
    if (!preset) return;
    this.smtpForm.patchValue({ host: preset.host, port: preset.port, secure: preset.secure });
    this.presetNote = preset.note;
  }

  /** 465 is implicit TLS, 587 is STARTTLS — keep the flag consistent with the port. */
  onPortChange(): void {
    const port = Number(this.smtpForm.value.port);
    if (port === 465) this.smtpForm.patchValue({ secure: true }, { emitEvent: false });
    if (port === 587 || port === 25) this.smtpForm.patchValue({ secure: false }, { emitEvent: false });
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.toast.error('Please correct the highlighted fields.');
      return;
    }

    this.saving = true;
    const body = this.form.value as any;
    const request = this.isNew
      ? this.service.create(body)
      : this.service.update(this.tenantId!, body);

    request.subscribe({
      next: (res) => {
        this.saving = false;
        this.toast.success(this.isNew ? 'Customer created.' : 'Customer saved.');
        if (this.isNew && res.data?.id) {
          this.tenantId = res.data.id;
          this.router.navigate(['/customers', res.data.id], { replaceUrl: true });
        }
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.message || 'Could not save.');
      }
    });
  }

  saveSmtp(): void {
    if (this.isNew) {
      this.toast.error('Save the customer details first.');
      return;
    }
    if (this.smtpForm.invalid) {
      this.smtpForm.markAllAsTouched();
      this.toast.error('Please correct the highlighted SMTP fields.');
      return;
    }

    this.savingSmtp = true;
    this.service.saveSmtp(this.tenantId!, this.smtpForm.value as any).subscribe({
      next: () => {
        this.savingSmtp = false;
        this.smtpConfigured = true;
        this.smtpVerifiedAt = null;
        // Never keep the plaintext password in the page after it is stored.
        this.smtpForm.patchValue({ password: '' });
        this.smtpForm.controls.password.clearValidators();
        this.smtpForm.controls.password.updateValueAndValidity();
        this.toast.success('SMTP settings saved. Run "Test connection" to confirm they work.');
      },
      error: (err) => {
        this.savingSmtp = false;
        this.toast.error(err.error?.message || 'Could not save SMTP settings.');
      }
    });
  }

  testSmtp(): void {
    this.testing = true;
    this.service.testSmtp(this.tenantId!).subscribe({
      next: () => {
        this.testing = false;
        this.smtpVerifiedAt = new Date().toISOString();
        this.toast.success('SMTP connection successful.');
      },
      error: (err) => {
        this.testing = false;
        this.toast.error(err.error?.message || 'SMTP test failed.');
      }
    });
  }

  sendTestMail(): void {
    if (!this.testEmail) {
      this.toast.error('Enter an email address to send the test to.');
      return;
    }
    this.testing = true;
    this.service.sendTest(this.tenantId!, this.testEmail).subscribe({
      next: (res) => {
        this.testing = false;
        this.toast.success(res.message || 'Test email sent.');
      },
      error: (err) => {
        this.testing = false;
        this.toast.error(err.error?.message || 'Could not send test email.');
      }
    });
  }
}
