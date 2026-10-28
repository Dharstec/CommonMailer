import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Observable, Subject, Subscription, from, interval, of } from 'rxjs';
import { catchError, concatMap, debounceTime, map, switchMap, tap } from 'rxjs/operators';
import { CampaignService, TenantService } from '../../core/services/data.service';
import { ClipboardService } from '../../core/services/clipboard.service';
import { ToastService } from '../../core/services/toast.service';
import {
  ApiResponse, Campaign, CampaignAttachment, CampaignContent, CampaignDesign, CampaignPreview,
  CampaignRecipient, CampaignSender, CampaignStats, ImportSummary, Pagination, Tenant
} from '../../core/models';
import { STATUS_LABELS, campaignStatusClass } from './campaign-list.component';

type Tab = 'details' | 'recipients' | 'content' | 'send' | 'report';
type TextField = 'subject' | 'preheader' | 'headline' | 'body' | 'cta_text' | 'cta_url' | 'signature'
  | 'footer_text' | 'custom_html';

interface DesignOption {
  key: CampaignDesign;
  label: string;
  blurb: string;
  best: string;
}

interface Check {
  state: 'ok' | 'warn' | 'missing';
  label: string;
  detail: string;
  tab?: Tab;
}

interface Tip {
  good: boolean;
  text: string;
}

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_LIST_BYTES = 5 * 1024 * 1024;
const BRAND_DEFAULT = '#4f46e5';

const EMPTY_STATS: CampaignStats = {
  total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, opened: 0, unsubscribed: 0
};

const DESIGNS: DesignOption[] = [
  {
    key: 'executive', label: 'Executive',
    blurb: 'White card, brand colour along the top. Calm and professional.',
    best: 'Proposals, company profiles and B2B introductions — especially with a PDF or deck attached.'
  },
  {
    key: 'spotlight', label: 'Spotlight',
    blurb: 'Brand header, big centred headline, big button.',
    best: 'Launches, announcements and new services.'
  },
  {
    key: 'aurora', label: 'Aurora',
    blurb: 'Vivid gradient hero with the headline inside it.',
    best: 'Offers, events and anything that should feel exciting.'
  },
  {
    key: 'personal', label: 'Personal',
    blurb: 'Looks typed by a person. No banner, no images.',
    best: 'First contact with a company. Plain emails are the most likely to reach the Primary inbox and get a reply.'
  },
  {
    key: 'custom', label: 'Custom HTML',
    blurb: 'Paste your own HTML. Merge fields still work.',
    best: 'A design made in another tool.'
  }
];

const SWATCHES = ['#4f46e5', '#2563eb', '#0891b2', '#059669', '#65a30d', '#d97706', '#ea580c', '#e11d48', '#db2777', '#7c3aed', '#0f172a'];

/** Words spam filters weigh against a subject. A nudge, not a rule. */
const SPAM_WORDS = ['free', 'guarantee', 'winner', 'urgent', 'act now', 'risk-free', 'cash', '100%', 'click here',
  'limited time', 'earn money', 'no cost', 'offer expires', '$$$', 'buy now', 'congratulations', 'lowest price'];

/**
 * A new campaign starts with a real message rather than empty boxes: it shows
 * how merge fields, fallbacks and the formatting work, and the preview looks
 * finished from the first second. Every word of it is meant to be replaced.
 */
const STARTER: CampaignContent = {
  brand_color: BRAND_DEFAULT,
  logo_url: '',
  logo_width: 140,
  hero_image_url: '',
  headline: 'A better way to grow {{company|your business}}',
  body: 'Hi {{first_name|there}},\n\n'
    + 'I\'m reaching out because we help businesses like **{{company|yours}}** grow — and I think there is a quick win for you.\n\n'
    + 'Here\'s what we offer:\n'
    + '- **Benefit one** — what it does for them, in one line\n'
    + '- **Benefit two** — keep each point short\n'
    + '- **Benefit three** — three points is plenty\n\n'
    + 'I\'ve attached a short overview. Would you be open to a quick call next week?',
  cta_text: 'Book a 15-minute call',
  cta_url: '',
  signature: 'Warm regards,\n',
  footer_text: ''
};

const CUSTOM_STARTER = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:24px;color:#0f172a;">Hello {{first_name|there}}</h1>
    <p style="margin:0 0 16px;font-size:16px;line-height:26px;color:#334155;">
      Paste or write your own HTML here. Merge fields like {{company}} are filled in for every recipient.
    </p>
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;">
      <a href="{{_unsubscribe_url}}" style="color:#64748b;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`;

function blankCampaign(): Campaign {
  return {
    tenant_id: null,
    name: '',
    status: 'draft',
    from_name: '',
    from_email: '',
    reply_to: '',
    subject: '{{first_name|Hi}}, a quick idea for {{company|your team}}',
    preheader: 'Two minutes to read — and one question for you.',
    design: 'executive',
    content: { ...STARTER },
    custom_html: '',
    track_opens: true,
    rate_per_minute: 20,
    daily_limit: 0
  };
}

export function formatBytes(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

@Component({
  selector: 'app-campaign-editor',
  templateUrl: './campaign-editor.component.html'
})
export class CampaignEditorComponent implements OnInit, OnDestroy {
  campaignId: number | null = null;
  campaign: Campaign = blankCampaign();
  tenants: Tenant[] = [];
  loading = false;
  saving = false;
  dirty = false;
  tab: Tab = 'details';

  // Recipients
  recipients: CampaignRecipient[] = [];
  recipientPage: Pagination = { page: 1, limit: 25, total: 0, pages: 0 };
  recipientFilter = { status: '', search: '' };
  recipientsLoading = false;
  previewChoices: CampaignRecipient[] = [];
  uploading = false;
  dragOver = false;
  pasteOpen = false;
  pasteText = '';
  importSummary: ImportSummary | null = null;
  importRejected = false;
  confirmClearOpen = false;

  // Content
  preview: CampaignPreview | null = null;
  previewHtml: SafeHtml | null = null;
  previewDevice: 'desktop' | 'mobile' = 'desktop';
  previewRecipientId: number | null = null;
  previewLoading = false;
  attachmentsUploading = 0;
  formattingOpen = false;

  // Send
  testEmail = '';
  testing = false;
  when: 'now' | 'later' = 'now';
  scheduleAt = '';
  confirmStartOpen = false;
  confirmCancelOpen = false;
  confirmDeleteOpen = false;
  acting = false;

  readonly designs = DESIGNS;
  readonly swatches = SWATCHES;
  readonly speeds = [5, 10, 20, 30, 60];
  readonly dailyPresets = [
    { label: 'No limit', value: 0 },
    { label: 'Gmail · 400', value: 400 },
    { label: 'Google Workspace · 1,800', value: 1800 }
  ];
  readonly statusLabels = STATUS_LABELS;
  readonly statusClass = campaignStatusClass;
  readonly formatBytes = formatBytes;
  readonly recipientStatusLabel: Record<string, string> = {
    pending: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped'
  };

  // Kept out of the template: Angular reads a literal {{ in HTML as interpolation.
  readonly fallbackExample = '{{first_name|there}}';
  readonly unsubscribeToken = '{{_unsubscribe_url}}';

  private focus: { field: TextField; el: HTMLInputElement | HTMLTextAreaElement } | null = null;
  private savedTenantId: number | null = null;
  private nextTab: Tab | null = null;
  private preview$ = new Subject<void>();
  private subs = new Subscription();
  private poll?: Subscription;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private service: CampaignService,
    private tenantService: TenantService,
    private clipboard: ClipboardService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.testEmail = this.readStored('cm_test_email');

    this.tenantService.list().subscribe((data) => {
      this.tenants = data;
      if (this.isNew && !this.campaign.tenant_id && data.length === 1) this.selectTenant(data[0].id ?? null);
    });

    this.subs.add(this.preview$.pipe(
      debounceTime(400),
      switchMap(() => this.fetchPreview())
    ).subscribe((res) => {
      this.previewLoading = false;
      if (!res) return;
      this.preview = res.data;
      this.previewRecipientId = res.data.recipient_id;
      // The iframe is sandboxed with scripts off, so the email's own styles can
      // render without the HTML being able to run anything. Angular's sanitiser
      // would otherwise strip every style attribute — that is, the whole design.
      this.previewHtml = this.sanitizer.bypassSecurityTrustHtml(res.data.html);
    }));

    // Duplicate navigates from one campaign to another and Angular reuses this
    // component, so the id is followed rather than read once.
    this.subs.add(this.route.paramMap.subscribe((params) => this.init(params.get('id'))));
  }

  ngOnDestroy(): void {
    // Leaving with unsaved edits saves them instead of dropping them.
    if (this.dirty && !this.isNew && this.canEditContent) this.persist().subscribe({ error: () => undefined });
    this.subs.unsubscribe();
    this.stopPolling();
  }

  @HostListener('window:beforeunload', ['$event'])
  warnUnsaved(event: BeforeUnloadEvent): void {
    if (!this.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  }

  // ---------------------------------------------------------------- state --

  get isNew(): boolean { return this.campaignId === null; }
  get stats(): CampaignStats { return this.campaign.stats || EMPTY_STATS; }
  get canEditContent(): boolean { return this.isNew || Boolean(this.campaign.editable?.content); }
  get canEditRecipients(): boolean { return Boolean(this.campaign.editable?.recipients); }
  get hasReport(): boolean { return !this.isNew && this.campaign.status !== 'draft'; }
  get rich(): boolean { return ['executive', 'spotlight', 'aurora'].includes(this.campaign.design); }

  get selectedDesign(): DesignOption {
    return DESIGNS.find((d) => d.key === this.campaign.design) || DESIGNS[0];
  }

  get tabs(): { key: Tab; label: string }[] {
    const tabs: { key: Tab; label: string }[] = [
      { key: 'details', label: '1. Details' },
      { key: 'recipients', label: '2. Recipients' },
      { key: 'content', label: '3. Design & content' },
      { key: 'send', label: '4. Review & send' }
    ];
    if (this.hasReport) tabs.push({ key: 'report', label: 'Report' });
    return tabs;
  }

  get tenant(): Tenant | undefined {
    return this.tenants.find((t) => t.id === this.campaign.tenant_id);
  }

  /** The saved account. Undefined while a different customer is picked but not yet saved. */
  get sender(): CampaignSender | undefined {
    return this.campaign.tenant_id === this.savedTenantId ? this.campaign.sender : undefined;
  }

  get senderState(): 'ok' | 'untested' | 'missing' | 'unknown' {
    const sender = this.sender;
    if (sender) return !sender.configured ? 'missing' : sender.verified ? 'ok' : 'untested';
    const t = this.tenant;
    if (!t) return 'unknown';
    return !t.smtp_configured ? 'missing' : t.smtp_verified_at ? 'ok' : 'untested';
  }

  /** Sending as another domain breaks SPF/DKIM alignment, which is a fast way into spam. */
  get fromDomainWarning(): boolean {
    const custom = (this.campaign.from_email || '').trim().toLowerCase();
    const account = (this.sender?.from_email || '').toLowerCase();
    return Boolean(custom && account && custom.split('@')[1] !== account.split('@')[1]);
  }

  get brandColor(): string {
    const value = this.campaign.content.brand_color || '';
    return /^#[0-9a-f]{6}$/i.test(value) ? value : BRAND_DEFAULT;
  }

  get mergeFields(): string[] {
    return this.campaign.columns?.length ? this.campaign.columns : ['email', 'first_name', 'name', 'company'];
  }

  private init(param: string | null): void {
    this.stopPolling();
    this.preview = null;
    this.previewHtml = null;
    this.previewRecipientId = null;
    this.recipients = [];
    this.previewChoices = [];
    this.recipientFilter = { status: '', search: '' };
    this.importSummary = null;
    this.importRejected = false;
    this.focus = null;

    if (param && param !== 'new') {
      this.campaignId = Number(param);
      this.load(true);
      return;
    }

    this.campaignId = null;
    this.campaign = blankCampaign();
    this.savedTenantId = null;
    this.tab = 'details';
    const preselected = this.route.snapshot.queryParamMap.get('tenant');
    if (preselected) this.selectTenant(Number(preselected));
    else if (this.tenants.length === 1) this.selectTenant(this.tenants[0].id ?? null);
    this.dirty = false;
  }

  private load(initial = false): void {
    if (initial) this.loading = true;
    this.service.get(this.campaignId!).subscribe({
      next: (data) => {
        this.apply(data);
        this.loading = false;
        if (initial) {
          this.tab = this.nextTab || (this.hasReport ? 'report' : 'details');
          this.nextTab = null;
          this.loadRecipients();
          this.loadPreviewChoices();
          this.schedulePreview();
        }
        this.syncPolling();
      },
      error: () => { this.loading = false; }
    });
  }

  private apply(data: Campaign): void {
    this.campaign = {
      ...data,
      from_name: data.from_name || '',
      from_email: data.from_email || '',
      reply_to: data.reply_to || '',
      preheader: data.preheader || '',
      custom_html: data.custom_html || '',
      content: { brand_color: BRAND_DEFAULT, logo_width: 140, ...(data.content || {}) }
    };
    this.savedTenantId = data.tenant_id;
    this.importSummary = data.import_summary || null;
    this.dirty = false;
  }

  /** Called on every edit; the preview follows a moment later. */
  changed(): void {
    this.dirty = true;
    this.schedulePreview();
  }

  schedulePreview(): void {
    if (!this.campaignId) return;
    this.previewLoading = true;
    this.preview$.next();
  }

  private fetchPreview(): Observable<ApiResponse<CampaignPreview> | null> {
    if (!this.campaignId) return of(null);
    // A half-typed link fails validation; keep showing the last good preview.
    return this.service.preview(this.campaignId, { ...this.payload(), recipient_id: this.previewRecipientId })
      .pipe(catchError(() => of(null)));
  }

  previewAs(id: number | null): void {
    this.previewRecipientId = id;
    this.schedulePreview();
  }

  private payload(): Campaign {
    const c = this.campaign;
    const width = Number(c.content.logo_width);
    return {
      tenant_id: c.tenant_id,
      name: (c.name || '').trim(),
      from_name: (c.from_name || '').trim() || null,
      from_email: (c.from_email || '').trim() || null,
      reply_to: (c.reply_to || '').trim() || null,
      subject: (c.subject || '').trim(),
      preheader: (c.preheader || '').trim() || null,
      design: c.design,
      content: {
        ...c.content,
        logo_width: Number.isFinite(width) && width > 0 ? Math.min(300, Math.max(40, Math.round(width))) : null
      },
      custom_html: c.custom_html || null,
      track_opens: c.track_opens,
      rate_per_minute: Number(c.rate_per_minute) || 20,
      daily_limit: Math.max(0, Math.floor(Number(c.daily_limit) || 0))
    };
  }

  /** Saves the editor's state; emits once the server has it. */
  private persist(): Observable<Campaign> {
    const body = this.payload();
    const wasNew = this.isNew;
    this.saving = true;
    const request = wasNew ? this.service.create(body) : this.service.update(this.campaignId!, body);
    return request.pipe(
      map((res) => res.data),
      tap({
        next: (data) => {
          this.saving = false;
          this.dirty = false;
          if (wasNew) {
            this.nextTab = 'recipients';
            this.router.navigate(['/campaigns', data.id], { replaceUrl: true });
          } else if (body.tenant_id !== this.savedTenantId) {
            // A different sender means a different account and do-not-email list.
            this.load();
          }
        },
        error: () => { this.saving = false; }
      })
    );
  }

  /** Runs `next` once pending edits are saved, so the server acts on what is on screen. */
  private afterSave<T>(next: () => Observable<T>): Observable<T> {
    return this.dirty && this.canEditContent && !this.isNew ? this.persist().pipe(switchMap(() => next())) : next();
  }

  save(): void {
    if (!this.campaign.tenant_id) {
      this.tab = 'details';
      this.toast.error('Choose which customer sends this campaign.');
      return;
    }
    if ((this.campaign.name || '').trim().length < 2) {
      this.tab = 'details';
      this.toast.error('Give the campaign a name. Only you see it.');
      return;
    }
    const wasNew = this.isNew;
    this.persist().subscribe({
      next: () => this.toast.success(wasNew ? 'Campaign created. Next: upload the recipient list.' : 'Saved.'),
      error: (err: HttpErrorResponse) => this.fail(err, 'Could not save the campaign.')
    });
  }

  go(tab: Tab): void {
    if (this.isNew && tab !== 'details') {
      this.toast.info('Save the details first — the other steps open after that.');
      return;
    }
    if (this.dirty && this.canEditContent && !this.isNew) {
      this.persist().subscribe({ error: (err: HttpErrorResponse) => this.fail(err, 'Could not save your changes.') });
    }
    this.tab = tab;
    if (tab === 'recipients' || tab === 'report') this.loadRecipients(true);
    if (tab === 'content' || tab === 'details') this.schedulePreview();
  }

  // -------------------------------------------------------------- details --

  selectTenant(id: number | null): void {
    this.campaign.tenant_id = id;
    const t = this.tenants.find((x) => x.id === id);
    // Sign off as the customer until someone writes a real signature.
    if (t && /^Warm regards,\s*$/.test(this.campaign.content.signature || '')) {
      this.campaign.content.signature = `Warm regards,\n${t.name}`;
    }
    this.changed();
  }

  get subjectTips(): Tip[] {
    const subject = (this.campaign.subject || '').trim();
    if (!subject) return [];
    const text = subject.replace(/\{\{[^}]*\}\}/g, 'Priya');
    const tips: Tip[] = [];

    tips.push(text.length > 60
      ? { good: false, text: `${text.length} characters — phones cut subjects at about 40–50. Put the important words first.` }
      : { good: true, text: `${text.length} characters — fits on a phone screen.` });
    tips.push(/\{\{/.test(subject)
      ? { good: true, text: 'Personalised — a name or company in the subject is noticed first.' }
      : { good: false, text: 'Add a merge field like first_name or company — personal subjects get opened more.' });

    if (/\b[A-Z]{4,}\b/.test(subject.replace(/\{\{[^}]*\}\}/g, ''))) {
      tips.push({ good: false, text: 'Avoid words in ALL CAPS — spam filters score them.' });
    }
    if (/[!?]{2,}/.test(subject)) tips.push({ good: false, text: 'One exclamation or question mark at most.' });
    const spammy = SPAM_WORDS.find((w) => text.toLowerCase().includes(w));
    if (spammy) tips.push({ good: false, text: `"${spammy}" is a common spam-filter trigger.` });
    if (/^(re|fwd?)\s*:/i.test(subject)) tips.push({ good: false, text: 'A fake "Re:" or "Fwd:" breaks trust, and Gmail flags it.' });
    return tips;
  }

  get preheaderTip(): Tip {
    const text = (this.campaign.preheader || '').trim();
    if (!text) return { good: false, text: 'Without preview text, inboxes show the first words of the email instead — often the logo text.' };
    if (text.length < 35) return { good: false, text: 'Add a few more words — 40 to 100 characters fills the preview line.' };
    return { good: true, text: 'Good — this line sells the open, right after the subject.' };
  }

  /** What the inbox row will show, using the preview's merged values when there is one. */
  get inbox(): { from: string; subject: string; preheader: string; initial: string } {
    const p = this.preview;
    const from = (this.campaign.from_name || '').trim() || p?.from_name || this.sender?.from_name || this.tenant?.name || 'Your company';
    return {
      from,
      subject: p?.subject || this.campaign.subject || '(no subject)',
      preheader: p?.preheader ?? this.campaign.preheader ?? '',
      initial: from.trim().charAt(0).toUpperCase() || '?'
    };
  }

  // ----------------------------------------------------------- recipients --

  loadRecipients(quiet = false, page = this.recipientPage.page): void {
    if (!this.campaignId) return;
    if (!quiet) this.recipientsLoading = true;
    this.service.recipients(this.campaignId, { ...this.recipientFilter, page, limit: this.recipientPage.limit }).subscribe({
      next: (res) => {
        this.recipients = res.data;
        if (res.pagination) this.recipientPage = res.pagination;
        this.recipientsLoading = false;
      },
      error: () => { this.recipientsLoading = false; }
    });
  }

  private loadPreviewChoices(): void {
    if (!this.campaignId) return;
    this.service.recipients(this.campaignId, { page: 1, limit: 20 }).subscribe((res) => (this.previewChoices = res.data));
  }

  get recipientPages(): number[] {
    const total = this.recipientPage.pages;
    const first = Math.max(1, this.recipientPage.page - 2);
    const last = Math.min(total, first + 4);
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
  }

  recipientName(r: CampaignRecipient): string {
    const d = r.data || {};
    return d['name'] || [d['first_name'], d['last_name']].filter(Boolean).join(' ');
  }

  recipientStatusClass(status: string): string {
    if (status === 'sent') return 'badge-ok';
    if (status === 'failed') return 'badge-err';
    if (status === 'sending') return 'badge bg-brand-50 text-brand-700 ring-1 ring-brand-100';
    return 'badge-mute';
  }

  onListFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.uploadList(file, file.name);
  }

  onListDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) this.uploadList(file, file.name);
  }

  importPasted(): void {
    const text = this.pasteText.trim();
    if (text) this.uploadList(new Blob([text], { type: 'text/csv' }), 'pasted-list.csv');
  }

  private uploadList(file: Blob, filename: string): void {
    if (!this.campaignId || !this.canEditRecipients) return;
    if (file.size > MAX_LIST_BYTES) {
      this.toast.error('The list is larger than 5 MB. Split it into smaller files.');
      return;
    }
    this.uploading = true;
    this.afterSave(() => this.service.uploadRecipients(this.campaignId!, file, filename)).subscribe({
      next: (res) => {
        this.uploading = false;
        this.importSummary = res.data;
        this.importRejected = false;
        this.pasteOpen = false;
        this.pasteText = '';
        this.previewRecipientId = null;
        this.toast.success(res.message || 'List uploaded.');
        this.load();
        this.loadRecipients(false, 1);
        this.loadPreviewChoices();
        this.schedulePreview();
      },
      error: (err: HttpErrorResponse) => {
        this.uploading = false;
        if (err.status === 400 && err.error?.data) {
          this.importSummary = err.error.data;
          this.importRejected = true;
        }
        this.fail(err, 'Could not read that file.');
      }
    });
  }

  clearList(): void {
    this.service.clearRecipients(this.campaignId!).subscribe({
      next: () => {
        this.confirmClearOpen = false;
        this.importSummary = null;
        this.previewRecipientId = null;
        this.previewChoices = [];
        this.toast.success('Recipient list cleared.');
        this.load();
        this.loadRecipients(false, 1);
        this.schedulePreview();
      },
      error: () => { this.confirmClearOpen = false; }
    });
  }

  downloadSample(): void {
    const rows = [
      'email,first_name,last_name,company,city',
      'priya@acmetextiles.in,Priya,Raman,Acme Textiles,Coimbatore',
      'rajesh@globexsteel.com,Rajesh,Kumar,Globex Steel,Chennai',
      'anitha@initech.co.in,Anitha,,Initech Solutions,Bengaluru'
    ];
    // The byte-order mark makes Excel open it as UTF-8, so names in any script survive.
    this.saveBlob(new Blob(['\uFEFF' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), 'recipients-sample.csv');
  }

  exportResults(): void {
    const name = (this.campaign.name || 'campaign').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    this.service.exportRecipients(this.campaignId!).subscribe((blob) => this.saveBlob(blob, `${name || 'campaign'}-results.csv`));
  }

  private saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------------------------------------------------------------- content --

  selectDesign(key: CampaignDesign): void {
    if (!this.canEditContent) return;
    this.campaign.design = key;
    if (key === 'custom' && !(this.campaign.custom_html || '').trim()) this.campaign.custom_html = CUSTOM_STARTER;
    this.changed();
  }

  setBrand(value: string): void {
    this.campaign.content.brand_color = value;
    this.changed();
  }

  token(key: string): string {
    return `{{${key}}}`;
  }

  /** Remembers the last text box used, so a merge-field chip lands where the cursor was. */
  remember(field: TextField, event: FocusEvent): void {
    this.focus = { field, el: event.target as HTMLInputElement | HTMLTextAreaElement };
  }

  insert(key: string): void {
    const token = this.token(key);
    if (!this.focus || !this.canEditContent) {
      this.clipboard.copy(token, 'Merge field');
      return;
    }
    const { field, el } = this.focus;
    const current = this.getField(field);
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? start;
    this.setField(field, current.slice(0, start) + token + current.slice(end));
    this.changed();
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  private getField(field: TextField): string {
    switch (field) {
      case 'subject': return this.campaign.subject || '';
      case 'preheader': return this.campaign.preheader || '';
      case 'custom_html': return this.campaign.custom_html || '';
      default: return this.campaign.content[field] || '';
    }
  }

  private setField(field: TextField, value: string): void {
    switch (field) {
      case 'subject': this.campaign.subject = value; break;
      case 'preheader': this.campaign.preheader = value; break;
      case 'custom_html': this.campaign.custom_html = value; break;
      default: this.campaign.content[field] = value;
    }
  }

  get attachments(): CampaignAttachment[] {
    return this.campaign.attachments || [];
  }

  get attachmentBytes(): number {
    return this.attachments.reduce((sum, a) => sum + Number(a.size_bytes || 0), 0);
  }

  get attachmentPercent(): number {
    return Math.min(100, Math.round((this.attachmentBytes / MAX_ATTACHMENT_BYTES) * 100));
  }

  onAttachments(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length || !this.campaignId) return;

    // One at a time, so the server's running total sees every file before the next.
    from(files).pipe(
      concatMap((file) => {
        if (this.attachmentBytes + file.size > MAX_ATTACHMENT_BYTES) {
          this.toast.error(`${file.name} would take the attachments over 15 MB. Compress it, or share it as a link.`);
          return of(null);
        }
        this.attachmentsUploading += 1;
        return this.service.uploadAttachment(this.campaignId!, file).pipe(
          catchError((err: HttpErrorResponse) => {
            this.fail(err, `Could not attach ${file.name}.`);
            return of(null);
          }),
          tap(() => (this.attachmentsUploading -= 1))
        );
      })
    ).subscribe((res) => {
      if (!res) return;
      this.campaign.attachments = [...this.attachments, res.data];
      this.schedulePreview();
    });
  }

  removeAttachment(a: CampaignAttachment): void {
    this.service.removeAttachment(this.campaignId!, a.id).subscribe(() => {
      this.campaign.attachments = this.attachments.filter((x) => x.id !== a.id);
      this.schedulePreview();
    });
  }

  fileBadge(name: string): { text: string; color: string } {
    const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : '';
    const kinds: [string[], string][] = [
      [['pdf'], 'bg-red-600'],
      [['ppt', 'pptx', 'pps', 'ppsx', 'key', 'odp'], 'bg-orange-600'],
      [['doc', 'docx', 'odt', 'rtf', 'pages'], 'bg-blue-600'],
      [['xls', 'xlsx', 'xlsm', 'csv', 'ods', 'numbers'], 'bg-green-600'],
      [['zip', 'rar', '7z', 'gz', 'tar'], 'bg-violet-600'],
      [['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg'], 'bg-cyan-600'],
      [['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav'], 'bg-pink-600']
    ];
    const color = kinds.find(([exts]) => exts.includes(ext))?.[1] || 'bg-slate-500';
    return { text: (ext || 'file').slice(0, 4).toUpperCase(), color };
  }

  // ----------------------------------------------------------------- send --

  get checks(): Check[] {
    const c = this.campaign;
    const s = this.stats;
    const sender = this.sender;
    const message = c.design === 'custom'
      ? (c.custom_html || '').trim()
      : (c.content.body || '').trim() || (c.content.headline || '').trim();
    const footer = (c.content.footer_text || '').trim();
    const attached = this.attachments.length ? ` · ${this.attachments.length} attachment(s)` : '';

    return [
      sender?.configured
        ? {
          state: sender.verified ? 'ok' : 'warn',
          label: 'Sending account',
          detail: `${sender.from_email}${sender.verified ? '' : ' — not tested yet. Send yourself a test first.'}`,
          tab: 'details'
        }
        : { state: 'missing', label: 'Sending account', detail: 'This customer has no SMTP account set up.', tab: 'details' },
      {
        state: c.subject?.trim() ? 'ok' : 'missing', label: 'Subject line',
        detail: c.subject?.trim() || 'Write a subject line.', tab: 'details'
      },
      {
        state: c.preheader?.trim() ? 'ok' : 'warn', label: 'Preview text',
        detail: c.preheader?.trim() || 'Recommended — it shows next to the subject in the inbox.', tab: 'details'
      },
      {
        state: s.pending ? 'ok' : 'missing', label: 'Recipients',
        detail: s.pending ? `${s.pending.toLocaleString()} ready to send`
          : s.failed ? 'Nothing waiting — retry the failed ones from the report.' : 'Upload your list.',
        tab: 'recipients'
      },
      {
        state: message ? 'ok' : 'missing', label: 'Message',
        detail: message ? `${this.selectedDesign.label} design${attached}` : 'Write the message.', tab: 'content'
      },
      {
        state: footer ? 'ok' : 'warn', label: 'Postal address',
        detail: footer ? 'In the footer' : 'Recommended — anti-spam laws ask for one, and it builds trust.', tab: 'content'
      },
      { state: 'ok', label: 'Unsubscribe link', detail: 'Added to every email, plus the inbox\'s own unsubscribe button.' }
    ];
  }

  get canStart(): boolean {
    return !this.isNew
      && ['draft', 'paused', 'scheduled'].includes(this.campaign.status || '')
      && this.checks.every((c) => c.state !== 'missing');
  }

  /** How long the queue takes at the chosen speed and daily limit. */
  get estimate(): string {
    const n = this.stats.pending;
    if (!n) return '';
    const rate = Number(this.campaign.rate_per_minute) || 20;
    const daily = Number(this.campaign.daily_limit) || 0;
    if (daily && n > daily) return `about ${Math.ceil(n / daily)} days at ${daily.toLocaleString()} a day`;
    const minutes = Math.ceil(n / rate);
    if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
    return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  dailyIs(value: number): boolean {
    return Number(this.campaign.daily_limit) === value;
  }

  get minSchedule(): string {
    const d = new Date(Date.now() + 5 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  sendTest(): void {
    const to = this.testEmail.trim();
    if (!to) {
      this.toast.error('Enter the address to send the test to.');
      return;
    }
    this.store('cm_test_email', to);
    this.testing = true;
    this.service.sendTest(this.campaignId!, { ...this.payload(), to, recipient_id: this.previewRecipientId }).subscribe({
      next: (res) => {
        this.testing = false;
        this.toast.success(res.message || 'Test sent.');
      },
      error: (err: HttpErrorResponse) => {
        this.testing = false;
        this.fail(err, 'Could not send the test.');
      }
    });
  }

  askStart(): void {
    if (!this.canStart) return;
    if (this.when === 'later') {
      const at = new Date(this.scheduleAt);
      if (!this.scheduleAt || Number.isNaN(at.getTime())) {
        this.toast.error('Choose the date and time to send.');
        return;
      }
      if (at.getTime() <= Date.now()) {
        this.toast.error('That time has already passed.');
        return;
      }
    }
    this.confirmStartOpen = true;
  }

  start(): void {
    const scheduled = this.when === 'later' ? new Date(this.scheduleAt).toISOString() : null;
    this.acting = true;
    this.afterSave(() => this.service.start(this.campaignId!, scheduled)).subscribe({
      next: (res) => {
        this.acting = false;
        this.confirmStartOpen = false;
        this.toast.success(res.message || 'Started.');
        this.tab = 'report';
        this.load();
        this.loadRecipients(true, 1);
      },
      error: (err: HttpErrorResponse) => {
        this.acting = false;
        this.confirmStartOpen = false;
        this.fail(err, 'Could not start the campaign.');
      }
    });
  }

  /** Resume and "send now" skip the confirmation: the person already confirmed once. */
  resume(): void {
    this.when = 'now';
    this.start();
  }

  pause(): void { this.run(this.service.pause(this.campaignId!)); }
  retryFailed(): void { this.run(this.service.retryFailed(this.campaignId!)); }

  cancelCampaign(): void {
    this.confirmCancelOpen = false;
    this.run(this.service.cancel(this.campaignId!));
  }

  private run(request: Observable<ApiResponse<null>>): void {
    this.acting = true;
    request.subscribe({
      next: (res) => {
        this.acting = false;
        if (res.message) this.toast.success(res.message);
        this.load();
        this.loadRecipients(true);
      },
      error: (err: HttpErrorResponse) => {
        this.acting = false;
        this.fail(err, 'That did not work.');
      }
    });
  }

  duplicate(): void {
    this.afterSave(() => this.service.duplicate(this.campaignId!)).subscribe((res) => {
      this.toast.success(res.message || 'Copied.');
      this.router.navigate(['/campaigns', res.data.id]);
    });
  }

  remove(): void {
    this.service.remove(this.campaignId!).subscribe({
      next: () => {
        this.confirmDeleteOpen = false;
        this.dirty = false;
        this.toast.success('Campaign deleted.');
        this.router.navigate(['/campaigns']);
      },
      error: () => { this.confirmDeleteOpen = false; }
    });
  }

  // --------------------------------------------------------------- report --

  get openRate(): number {
    return this.stats.sent ? Math.round((this.stats.opened / this.stats.sent) * 100) : 0;
  }

  /** Width of each slice of the progress bar, as a percentage of the list. */
  share(count: number): number {
    return this.stats.total ? (count / this.stats.total) * 100 : 0;
  }

  private syncPolling(): void {
    const live = this.campaign.status === 'sending' || this.campaign.status === 'scheduled';
    if (live && !this.poll) this.poll = interval(4000).subscribe(() => this.refreshStatus());
    if (!live) this.stopPolling();
  }

  private stopPolling(): void {
    this.poll?.unsubscribe();
    this.poll = undefined;
  }

  /**
   * Refreshes status and counters only. A scheduled campaign can be open for
   * editing at the same time, and a full reload would overwrite the edits.
   * Stops on the first error, so a server restart produces one toast, not one
   * every four seconds.
   */
  private refreshStatus(): void {
    if (!this.campaignId) return;
    this.service.get(this.campaignId).subscribe({
      next: (data) => {
        Object.assign(this.campaign, {
          status: data.status,
          status_reason: data.status_reason,
          next_send_at: data.next_send_at,
          scheduled_at: data.scheduled_at,
          started_at: data.started_at,
          completed_at: data.completed_at,
          stats: data.stats,
          editable: data.editable
        });
        if (this.tab === 'report' || this.tab === 'recipients') this.loadRecipients(true);
        this.syncPolling();
      },
      error: () => this.stopPolling()
    });
  }

  // -------------------------------------------------------------- helpers --

  /** Anything but a 400 has already been shown by the interceptor. */
  private fail(err: HttpErrorResponse, fallback: string): void {
    if (err.status !== 400) return;
    const errors: { message: string }[] = err.error?.errors || [];
    this.toast.error(errors.length ? errors.map((e) => e.message).join('\n') : (err.error?.message || fallback));
  }

  private readStored(key: string): string {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  private store(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private browsing: remembering the address is only a convenience.
    }
  }
}
