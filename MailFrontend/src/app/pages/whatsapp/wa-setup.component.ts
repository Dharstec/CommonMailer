import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { WhatsappService } from '../../core/services/data.service';
import { ClipboardService } from '../../core/services/clipboard.service';
import { ToastService } from '../../core/services/toast.service';
import { WaAccountDetail, WaAccountForm, WaAccountSummary, WaNumberInfo } from '../../core/models';
import { limitOf, qualityOf } from './wa-shared';

function blankForm(): WaAccountForm {
  return { phone_number_id: '', waba_id: '', app_id: '', access_token: '', app_secret: '', default_country: '91', notify_emails: '' };
}

/**
 * Connecting a customer's WhatsApp number to Meta's Cloud API — a one-time job
 * done once in Meta's own screens. Each step says exactly where to click and
 * what to copy back here, so someone who has never seen Meta's developer site
 * can finish it.
 */
@Component({
  selector: 'app-wa-setup',
  templateUrl: './wa-setup.component.html'
})
export class WaSetupComponent implements OnInit, OnDestroy {
  accounts: WaAccountSummary[] = [];
  tenantId: number | null = null;
  detail: WaAccountDetail | null = null;
  loading = false;
  editing = false;
  step = 0;
  form: WaAccountForm = blankForm();
  saving = false;
  checking = false;
  testTo = '';
  testing = false;
  saveCheck: { ok: boolean; info?: WaNumberInfo; message?: string } | null = null;
  confirmDisconnect = false;

  readonly steps = [
    'Get a number ready',
    'Create the Meta app',
    'Permanent access token',
    'App ID and secret',
    'Replies, then save',
    'Connect the webhook',
    'Send a test'
  ];
  readonly qualityOf = qualityOf;
  readonly limitOf = limitOf;

  private poll?: Subscription;

  constructor(
    private service: WhatsappService,
    private route: ActivatedRoute,
    private router: Router,
    private clipboard: ClipboardService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    try { this.testTo = localStorage.getItem('cm_wa_test_to') || ''; } catch { /* private mode */ }
    this.service.accounts().subscribe((data) => {
      this.accounts = data;
      const wanted = Number(this.route.snapshot.queryParamMap.get('tenant'));
      const first = data.find((a) => a.tenant_id === wanted) || data.find((a) => a.connected) || data[0];
      if (first) this.choose(first.tenant_id);
    });
  }

  ngOnDestroy(): void {
    this.poll?.unsubscribe();
  }

  get account(): WaAccountDetail['account'] { return this.detail?.account || null; }

  choose(tenantId: number | null): void {
    this.tenantId = tenantId;
    this.saveCheck = null;
    this.poll?.unsubscribe();
    if (!tenantId) { this.detail = null; return; }
    this.router.navigate([], { queryParams: { tenant: tenantId }, replaceUrl: true });
    this.loading = true;
    this.service.account(tenantId).subscribe({
      next: (detail) => {
        this.detail = detail;
        this.loading = false;
        this.editing = !detail.connected;
        this.step = 0;
        const a = detail.account;
        this.form = a
          ? { phone_number_id: a.phone_number_id, waba_id: a.waba_id, app_id: a.app_id || '', access_token: '', app_secret: '',
            default_country: a.default_country, notify_emails: a.notify_emails || '' }
          : blankForm();
      },
      error: () => { this.loading = false; }
    });
  }

  edit(step = 1): void {
    this.editing = true;
    this.step = step;
    this.watchWebhook();
  }

  /** What each step needs before Next makes sense. */
  get stepReady(): boolean {
    const f = this.form;
    switch (this.step) {
      case 1: return /^\d{5,30}$/.test(f.phone_number_id.trim()) && /^\d{5,30}$/.test(f.waba_id.trim());
      case 2: return f.access_token.trim().length >= 20 || Boolean(this.account?.has_token);
      case 3: return /^[A-Za-z0-9]{16,64}$/.test(f.app_secret.trim()) || Boolean(this.account?.has_app_secret);
      default: return true;
    }
  }

  next(): void {
    if (this.step === 4) return this.save();
    this.step = Math.min(this.steps.length - 1, this.step + 1);
    this.watchWebhook();
  }

  back(): void {
    this.step = Math.max(0, this.step - 1);
    this.watchWebhook();
  }

  save(): void {
    if (!this.tenantId) return;
    this.saving = true;
    this.service.saveAccount(this.tenantId, { ...this.form, phone_number_id: this.form.phone_number_id.trim(), waba_id: this.form.waba_id.trim() }).subscribe({
      next: (res) => {
        this.saving = false;
        this.detail = res.data;
        this.saveCheck = res.check || null;
        this.form.access_token = '';
        this.form.app_secret = '';
        this.refreshAccounts();
        if (res.check?.ok) {
          this.toast.success(`Connected: ${res.check.info?.display_phone || 'number found'}.`);
          this.step = 5;
          this.watchWebhook();
        } else {
          this.toast.error(res.check?.message || 'Saved, but Meta did not answer as expected.');
        }
      },
      error: (err) => {
        this.saving = false;
        const errors: { message: string }[] = err.error?.errors || [];
        if (err.status === 400) this.toast.error(errors.length ? errors.map((e) => e.message).join('\n') : (err.error?.message || 'Could not save.'));
      }
    });
  }

  check(): void {
    if (!this.tenantId) return;
    this.checking = true;
    this.service.checkAccount(this.tenantId).subscribe({
      next: (res) => {
        this.checking = false;
        this.toast.success(`${res.data.display_phone} · quality ${qualityOf(res.data.quality_rating).label}.`);
        this.choose(this.tenantId);
        this.refreshAccounts();
      },
      error: (err) => {
        this.checking = false;
        if (err.status === 400) this.toast.error(err.error?.message || 'Meta did not answer.');
      }
    });
  }

  sendTest(): void {
    if (!this.tenantId || !this.testTo.trim()) return;
    try { localStorage.setItem('cm_wa_test_to', this.testTo.trim()); } catch { /* private mode */ }
    this.testing = true;
    this.service.testAccount(this.tenantId, this.testTo).subscribe({
      next: (res) => { this.testing = false; this.toast.success(res.message || 'Sent.'); },
      error: (err) => { this.testing = false; if (err.status === 400) this.toast.error(err.error?.message || 'Not sent.'); }
    });
  }

  copy(text: string | undefined, label: string): void {
    this.clipboard.copy(text || '', label);
  }

  disconnect(): void {
    this.confirmDisconnect = false;
    if (!this.tenantId) return;
    this.service.disconnect(this.tenantId).subscribe((res) => {
      this.toast.success(res.message || 'Disconnected.');
      this.refreshAccounts();
      this.choose(this.tenantId);
    });
  }

  finish(): void {
    this.editing = false;
    this.poll?.unsubscribe();
    this.choose(this.tenantId);
  }

  /** While the webhook step is open, notices the moment Meta calls. */
  private watchWebhook(): void {
    this.poll?.unsubscribe();
    if (this.step !== 5 || !this.tenantId || this.account?.webhook_seen_at) return;
    this.poll = interval(4000).subscribe(() => {
      this.service.account(this.tenantId!).subscribe((detail) => {
        this.detail = detail;
        if (detail.account?.webhook_seen_at) {
          this.poll?.unsubscribe();
          this.toast.success('Meta reached the webhook. Replies and delivery receipts will now come in.');
        }
      });
    });
  }

  private refreshAccounts(): void {
    this.service.accounts().subscribe((data) => (this.accounts = data));
  }
}
