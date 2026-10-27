import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { CampaignService, TenantService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import { Campaign, CampaignStatus, CampaignUnsubscribe, Tenant } from '../../core/models';

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled'
};

/** Shared with the editor so a status reads the same everywhere. */
export function campaignStatusClass(status: CampaignStatus | undefined): string {
  switch (status) {
    case 'sending': return 'badge bg-brand-50 text-brand-700 ring-1 ring-brand-100';
    case 'scheduled': return 'badge bg-sky-50 text-sky-700 ring-1 ring-sky-200';
    case 'paused': return 'badge-warn';
    case 'completed': return 'badge-ok';
    default: return 'badge-mute';
  }
}

@Component({
  selector: 'app-campaign-list',
  templateUrl: './campaign-list.component.html'
})
export class CampaignListComponent implements OnInit, OnDestroy {
  campaigns: Campaign[] = [];
  tenants: Tenant[] = [];
  loading = true;
  filters = { tenant_id: '' as number | '', status: '', search: '' };

  confirmOpen = false;
  pendingDelete: Campaign | null = null;

  // Do-not-email list
  listOpen = false;
  listTenantId: number | null = null;
  unsubscribes: CampaignUnsubscribe[] = [];
  listLoading = false;
  listSearch = '';
  addText = '';
  adding = false;

  readonly statusLabels = STATUS_LABELS;
  readonly statuses = Object.keys(STATUS_LABELS) as CampaignStatus[];
  readonly statusClass = campaignStatusClass;
  readonly sourceLabels: Record<string, string> = {
    link: 'Unsubscribe link', one_click: 'Inbox button', manual: 'Added by you'
  };

  private refresh?: Subscription;

  constructor(
    private service: CampaignService,
    private tenantService: TenantService,
    private router: Router,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.tenantService.list().subscribe((data) => (this.tenants = data));
    this.load();

    // Keeps progress moving while something is sending. Stops on the first
    // failure, so a server restart produces one toast, not one every 5 s.
    this.refresh = interval(5000).subscribe(() => {
      if (this.campaigns.some((c) => c.status === 'sending' || c.status === 'scheduled')) this.load(true);
    });
  }

  ngOnDestroy(): void {
    this.refresh?.unsubscribe();
  }

  load(quiet = false): void {
    if (!quiet) this.loading = true;
    this.service.list(this.filters).subscribe({
      next: (data) => { this.campaigns = data; this.loading = false; },
      error: () => {
        this.loading = false;
        this.refresh?.unsubscribe();
      }
    });
  }

  /** Width of one slice of the progress bar, as a percentage of the list. */
  share(c: Campaign, count: number): number {
    return c.stats?.total ? (count / c.stats.total) * 100 : 0;
  }

  openRate(c: Campaign): string {
    const s = c.stats;
    if (!s || !s.sent) return '—';
    return `${Math.round((s.opened / s.sent) * 100)}%`;
  }

  duplicate(c: Campaign): void {
    this.service.duplicate(c.id!).subscribe((res) => {
      this.toast.success(res.message || 'Copied.');
      this.router.navigate(['/campaigns', res.data.id]);
    });
  }

  askDelete(c: Campaign): void {
    this.pendingDelete = c;
    this.confirmOpen = true;
  }

  get deleteMessage(): string {
    const c = this.pendingDelete;
    if (!c) return '';
    return `"${c.name}", its recipient list and its report will be deleted.\n\n`
      + 'People who unsubscribed stay on the do-not-email list. This cannot be undone.';
  }

  confirmDelete(): void {
    if (!this.pendingDelete?.id) return;
    this.service.remove(this.pendingDelete.id).subscribe({
      next: () => {
        this.toast.success('Campaign deleted.');
        this.confirmOpen = false;
        this.load();
      },
      error: () => { this.confirmOpen = false; }
    });
  }

  // ------------------------------------------------------ do-not-email --

  openList(): void {
    this.listOpen = true;
    this.listTenantId = this.filters.tenant_id === '' ? (this.tenants[0]?.id ?? null) : Number(this.filters.tenant_id);
    this.loadList();
  }

  loadList(): void {
    this.unsubscribes = [];
    if (!this.listTenantId) return;
    this.listLoading = true;
    this.service.unsubscribes(this.listTenantId).subscribe({
      next: (data) => { this.unsubscribes = data; this.listLoading = false; },
      error: () => { this.listLoading = false; }
    });
  }

  get filteredUnsubscribes(): CampaignUnsubscribe[] {
    const term = this.listSearch.trim().toLowerCase();
    return term ? this.unsubscribes.filter((u) => u.email.includes(term)) : this.unsubscribes;
  }

  addToList(): void {
    if (!this.listTenantId || !this.addText.trim()) return;
    this.adding = true;
    this.service.addUnsubscribes(this.listTenantId, this.addText).subscribe({
      next: (res) => {
        this.adding = false;
        this.addText = '';
        this.toast.success(res.message || 'Added.');
        this.loadList();
      },
      error: (err: HttpErrorResponse) => {
        this.adding = false;
        if (err.status === 400) this.toast.error(err.error?.message || 'Could not add those addresses.');
      }
    });
  }

  removeFromList(u: CampaignUnsubscribe): void {
    this.service.removeUnsubscribe(u.id).subscribe((res) => {
      this.toast.success(res.message || 'Removed.');
      this.unsubscribes = this.unsubscribes.filter((x) => x.id !== u.id);
    });
  }
}
