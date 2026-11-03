import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { WhatsappService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import { CampaignStatus, WaAccountSummary, WaCampaign, WaOptout } from '../../core/models';
import { WA_STATUS_LABELS, qualityOf, waStatusClass } from './wa-shared';

@Component({
  selector: 'app-wa-list',
  templateUrl: './wa-list.component.html'
})
export class WaListComponent implements OnInit, OnDestroy {
  campaigns: WaCampaign[] = [];
  accounts: WaAccountSummary[] = [];
  loading = true;
  filters = { tenant_id: '' as number | '', status: '', search: '' };

  confirmOpen = false;
  pendingDelete: WaCampaign | null = null;

  // Do-not-message list
  listOpen = false;
  listTenantId: number | null = null;
  optouts: WaOptout[] = [];
  listLoading = false;
  listSearch = '';
  addText = '';
  adding = false;

  readonly statusLabels = WA_STATUS_LABELS;
  readonly statuses = Object.keys(WA_STATUS_LABELS) as CampaignStatus[];
  readonly statusClass = waStatusClass;
  readonly qualityOf = qualityOf;
  readonly sourceLabels: Record<string, string> = { reply: 'Replied STOP', button: 'Stop button', manual: 'Added by you' };

  private refresh?: Subscription;

  constructor(private service: WhatsappService, private router: Router, private toast: ToastService) {}

  ngOnInit(): void {
    this.service.accounts().subscribe((data) => (this.accounts = data));
    this.load();
    this.refresh = interval(5000).subscribe(() => {
      if (this.campaigns.some((c) => c.status === 'sending' || c.status === 'scheduled')) this.load(true);
    });
  }

  ngOnDestroy(): void {
    this.refresh?.unsubscribe();
  }

  get connected(): WaAccountSummary[] { return this.accounts.filter((a) => a.connected); }

  get filtering(): boolean { return Boolean(this.filters.status || this.filters.search || this.filters.tenant_id); }

  load(quiet = false): void {
    if (!quiet) this.loading = true;
    this.service.list(this.filters).subscribe({
      next: (data) => { this.campaigns = data; this.loading = false; },
      error: () => { this.loading = false; this.refresh?.unsubscribe(); }
    });
  }

  share(c: WaCampaign, count: number): number {
    return c.stats?.total ? (count / c.stats.total) * 100 : 0;
  }

  duplicate(c: WaCampaign): void {
    this.service.duplicate(c.id!).subscribe((res) => {
      this.toast.success(res.message || 'Copied.');
      this.router.navigate(['/whatsapp', res.data.id]);
    });
  }

  askDelete(c: WaCampaign): void {
    this.pendingDelete = c;
    this.confirmOpen = true;
  }

  get deleteMessage(): string {
    return this.pendingDelete
      ? `"${this.pendingDelete.name}", its contact list, its replies and its report will be deleted.\n\n`
        + 'Numbers on the do-not-message list stay there. This cannot be undone.'
      : '';
  }

  confirmDelete(): void {
    const c = this.pendingDelete;
    this.confirmOpen = false;
    if (!c) return;
    this.service.remove(c.id!).subscribe(() => {
      this.toast.success('Campaign deleted.');
      this.load();
    });
  }

  // ---------------------------------------------------- do-not-message list --

  openList(): void {
    this.listOpen = true;
    if (!this.listTenantId && this.connected.length === 1) this.listTenantId = this.connected[0].tenant_id;
    this.loadList();
  }

  loadList(): void {
    if (!this.listTenantId) { this.optouts = []; return; }
    this.listLoading = true;
    this.service.optouts(this.listTenantId).subscribe({
      next: (data) => { this.optouts = data; this.listLoading = false; },
      error: () => { this.listLoading = false; }
    });
  }

  get filteredOptouts(): WaOptout[] {
    const q = this.listSearch.replace(/[\s+()-]/g, '');
    return q ? this.optouts.filter((o) => o.phone.includes(q)) : this.optouts;
  }

  addToList(): void {
    if (!this.listTenantId || !this.addText.trim()) return;
    this.adding = true;
    this.service.addOptouts(this.listTenantId, this.addText).subscribe({
      next: (res) => {
        this.adding = false;
        this.addText = '';
        this.toast.success(res.message || 'Added.');
        this.loadList();
      },
      error: () => { this.adding = false; }
    });
  }

  removeFromList(o: WaOptout): void {
    this.service.removeOptout(o.id).subscribe(() => {
      this.optouts = this.optouts.filter((x) => x.id !== o.id);
      this.toast.success(`${o.phone_display} can get WhatsApp campaigns again.`);
    });
  }
}
