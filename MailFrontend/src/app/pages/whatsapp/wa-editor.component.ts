import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Observable, Subscription, interval, of } from 'rxjs';
import { WhatsappService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import {
  ApiResponse, Pagination, WaAccountSummary, WaCampaign, WaConversation, WaImportSummary, WaRecipient, WaStats,
  WaTemplate, WaTemplateDraft, WaTemplateComponent
} from '../../core/models';
import { prepareEmailImage } from '../campaigns/email-image';
import {
  WA_LANGUAGES, WA_RECIPIENT_LABELS, WA_STATUS_LABELS, WaSlots, fill, limitOf, merge, qualityOf, sampleTemplate,
  slotsOf, variablesIn, waFormat, waRecipientClass, waStatusClass
} from './wa-shared';

type Step = 'details' | 'message' | 'contacts' | 'send' | 'report';

interface Check {
  state: 'ok' | 'warn' | 'missing';
  label: string;
  detail: string;
  step?: Step;
}

/** What the phone preview draws: a template filled in for one person. */
interface Bubble {
  headerFormat: string | null;
  headerText: string;
  headerImage: string;
  body: SafeHtml;
  footer: string;
  buttons: { type: string; text: string }[];
}

const EMPTY_STATS: WaStats = { total: 0, pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, replied: 0 };
const SAMPLE = { first_name: 'Priya', company: 'Acme Textiles', city: 'Coimbatore' };
const MAX_LIST_BYTES = 5 * 1024 * 1024;

function blankCampaign(): WaCampaign {
  return {
    tenant_id: null, name: '', status: 'draft',
    template_name: null, template_language: null, template_category: null, template_format: null, template_components: null,
    variables: { header: {}, body: {}, buttons: {} }, header_media_url: null
  };
}

function blankDraft(name: string): WaTemplateDraft {
  return {
    name: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'my_campaign',
    category: 'MARKETING', language: 'en', header_format: 'NONE', header_text: '', header_image_url: '',
    body: '', examples: {}, footer: '',
    buttons: [{ type: 'QUICK_REPLY', text: 'Yes, show me a demo' }, { type: 'QUICK_REPLY', text: 'Stop promotions' }]
  };
}

@Component({
  selector: 'app-wa-editor',
  templateUrl: './wa-editor.component.html'
})
export class WaEditorComponent implements OnInit, OnDestroy {
  campaignId: number | null = null;
  campaign: WaCampaign = blankCampaign();
  accounts: WaAccountSummary[] = [];
  step: Step = 'details';
  loading = false;
  saving = false;
  dirty = false;

  // Message
  templates: WaTemplate[] = [];
  templatesLoading = false;
  templatesError = '';
  headerUploading = false;
  previewRecipientId: number | null = null;
  previewChoices: WaRecipient[] = [];

  // Template creator
  creatorOpen = false;
  draft: WaTemplateDraft = blankDraft('');
  creating = false;
  draftImageUploading = false;

  // Contacts
  recipients: WaRecipient[] = [];
  recipientPage: Pagination = { page: 1, limit: 25, total: 0, pages: 0 };
  recipientFilter = { status: '', search: '' };
  recipientsLoading = false;
  uploading = false;
  dragOver = false;
  pasteOpen = false;
  pasteText = '';
  importSummary: WaImportSummary | null = null;
  confirmClearOpen = false;
  recipientToRemove: WaRecipient | null = null;

  // Send
  testTo = '';
  testing = false;
  consent = false;
  when: 'now' | 'later' = 'now';
  scheduleAt = '';
  confirmStartOpen = false;
  confirmCancelOpen = false;
  confirmDeleteOpen = false;
  acting = false;

  // Report
  conversations: WaConversation[] = [];
  openThread: string | null = null;
  replyText: Record<string, string> = {};
  replying = false;

  readonly statusLabels = WA_STATUS_LABELS;
  readonly statusClass = waStatusClass;
  readonly recipientLabels = WA_RECIPIENT_LABELS;
  readonly recipientClass = waRecipientClass;
  readonly qualityOf = qualityOf;
  readonly limitOf = limitOf;
  readonly languages = WA_LANGUAGES;
  // Kept out of the template: Angular reads a literal {{ in HTML as interpolation.
  readonly exampleMerge = '{{first_name|Sir/Madam}}';
  readonly bodyPlaceholder = 'Hello {{1}}, …';

  private poll?: Subscription;
  private replyPoll?: Subscription;

  constructor(
    private service: WhatsappService,
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    try { this.testTo = localStorage.getItem('cm_wa_test_to') || ''; } catch { /* private mode */ }
    this.service.accounts().subscribe((data) => {
      this.accounts = data;
      if (this.isNew) {
        const wanted = Number(this.route.snapshot.queryParamMap.get('tenant'));
        const connected = data.filter((a) => a.connected);
        this.campaign.tenant_id = (data.find((a) => a.tenant_id === wanted) || (connected.length === 1 ? connected[0] : null))?.tenant_id ?? null;
      }
    });
    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      this.campaignId = id && id !== 'new' ? Number(id) : null;
      if (this.campaignId) this.load(true);
    });
  }

  ngOnDestroy(): void {
    this.poll?.unsubscribe();
    this.replyPoll?.unsubscribe();
  }

  // ---------------------------------------------------------------- state --

  get isNew(): boolean { return this.campaignId === null; }
  get stats(): WaStats { return this.campaign.stats || EMPTY_STATS; }
  get started(): boolean { return !this.isNew && !['draft'].includes(this.campaign.status || 'draft'); }
  get canEdit(): boolean { return this.isNew || Boolean(this.campaign.editable?.content); }
  get canEditList(): boolean { return Boolean(this.campaign.editable?.recipients); }
  get account(): WaAccountSummary | undefined { return this.accounts.find((a) => a.tenant_id === this.campaign.tenant_id); }
  get connected(): WaAccountSummary[] { return this.accounts.filter((a) => a.connected); }
  get slots(): WaSlots { return slotsOf(this.campaign.template_components); }
  get chosen(): WaTemplate | undefined {
    return this.templates.find((t) => t.name === this.campaign.template_name && t.language === this.campaign.template_language);
  }
  get needsMedia(): boolean { return ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(this.slots.headerFormat || ''); }
  get columns(): string[] {
    const cols = this.campaign.columns?.length ? this.campaign.columns : ['first_name', 'company'];
    return cols.filter((c) => c !== 'phone');
  }

  get steps(): { key: Step; label: string; done: boolean }[] {
    const list: { key: Step; label: string; done: boolean }[] = [
      { key: 'details', label: 'Details', done: !this.isNew && Boolean(this.account?.connected) },
      { key: 'message', label: 'Message', done: this.messageReady },
      { key: 'contacts', label: 'Contacts', done: this.stats.total > 0 },
      { key: 'send', label: 'Review & send', done: this.started }
    ];
    if (this.started) list.push({ key: 'report', label: 'Report', done: false });
    return list;
  }

  get messageReady(): boolean {
    const s = this.slots;
    const v = this.campaign.variables;
    return Boolean(this.campaign.template_name)
      && s.body.every((n) => (v.body[n] || '').trim())
      && s.header.every((n) => (v.header[n] || '').trim())
      && s.buttons.every((b) => (v.buttons[b.index] || '').trim())
      && (!this.needsMedia || Boolean((this.campaign.header_media_url || '').trim()));
  }

  go(step: Step): void {
    if (this.isNew && step !== 'details') {
      this.toast.info('Give the campaign a name and a number first.');
      return;
    }
    const leave = this.dirty && this.canEdit ? this.persist() : of(null);
    leave.subscribe(() => {
      this.step = step;
      if (step === 'message' && !this.templates.length) this.loadTemplates();
      if (step === 'contacts' || step === 'report') this.loadRecipients(false, 1);
      if (step === 'report') this.loadConversations();
      this.syncPolling();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  next(): void {
    const order: Step[] = ['details', 'message', 'contacts', 'send'];
    const i = order.indexOf(this.step);
    if (this.step === 'details') return this.saveDetails();
    if (i >= 0 && i < order.length - 1) this.go(order[i + 1]);
  }

  back(): void {
    const order: Step[] = ['details', 'message', 'contacts', 'send'];
    const i = order.indexOf(this.step);
    if (i > 0) this.go(order[i - 1]);
  }

  changed(): void { this.dirty = true; }

  // ------------------------------------------------------------- loading --

  load(first = false): void {
    if (!this.campaignId) return;
    this.loading = first;
    this.service.get(this.campaignId).subscribe({
      next: (data) => {
        this.campaign = {
          ...data,
          variables: { header: data.variables?.header || {}, body: data.variables?.body || {}, buttons: data.variables?.buttons || {} }
        };
        this.importSummary = data.import_summary || null;
        this.loading = false;
        this.dirty = false;
        if (first) {
          this.step = this.started ? 'report' : (!data.template_name ? 'message' : (!data.stats?.total ? 'contacts' : 'send'));
          if (this.step === 'message' || data.template_name) this.loadTemplates();
          if (this.step === 'report') { this.loadRecipients(false, 1); this.loadConversations(); }
          this.loadPreviewChoices();
        }
        this.syncPolling();
      },
      error: () => { this.loading = false; }
    });
  }

  private payload(): WaCampaign {
    const c = this.campaign;
    return {
      tenant_id: c.tenant_id,
      name: (c.name || '').trim(),
      template_name: c.template_name,
      template_language: c.template_language,
      template_category: c.template_category,
      template_format: c.template_format,
      template_components: c.template_components,
      variables: c.variables,
      header_media_url: (c.header_media_url || '').trim() || null
    };
  }

  private persist(): Observable<WaCampaign | null> {
    const body = this.payload();
    this.saving = true;
    const request = this.isNew ? this.service.create(body) : this.service.update(this.campaignId!, body);
    return new Observable<WaCampaign | null>((subscriber) => {
      request.subscribe({
        next: (res) => {
          this.saving = false;
          this.dirty = false;
          subscriber.next(res.data);
          subscriber.complete();
        },
        error: (err: HttpErrorResponse) => {
          this.saving = false;
          this.fail(err, 'Could not save.');
          subscriber.complete();
        }
      });
    });
  }

  save(): void {
    this.persist().subscribe((data) => { if (data) this.toast.success('Saved.'); });
  }

  saveDetails(): void {
    if ((this.campaign.name || '').trim().length < 2) { this.toast.error('Give the campaign a name.'); return; }
    if (!this.campaign.tenant_id) { this.toast.error('Choose the WhatsApp number to send from.'); return; }
    const wasNew = this.isNew;
    this.persist().subscribe((data) => {
      if (!data) return;
      if (wasNew) {
        this.toast.success('Campaign created. Next: choose the message.');
        this.router.navigate(['/whatsapp', data.id], { replaceUrl: true });
        this.campaignId = data.id!;
        this.campaign = { ...this.campaign, ...data, variables: this.campaign.variables };
        this.step = 'message';
        this.loadTemplates();
        this.load();
      } else {
        this.go('message');
      }
    });
  }

  // ------------------------------------------------------------ templates --

  loadTemplates(): void {
    if (!this.campaign.tenant_id || !this.account?.connected) return;
    this.templatesLoading = true;
    this.templatesError = '';
    this.service.templates(this.campaign.tenant_id).subscribe({
      next: (data) => {
        this.templates = data.filter((t) => t.status !== 'DELETED');
        this.templatesLoading = false;
      },
      error: (err: HttpErrorResponse) => {
        this.templatesLoading = false;
        this.templatesError = err.error?.message || 'Meta did not answer.';
      }
    });
  }

  choose(t: WaTemplate): void {
    if (!this.canEdit) return;
    const keep = this.campaign.template_name === t.name && this.campaign.template_language === t.language;
    this.campaign.template_name = t.name;
    this.campaign.template_language = t.language;
    this.campaign.template_category = t.category;
    this.campaign.template_format = t.parameter_format || 'POSITIONAL';
    this.campaign.template_components = t.components;
    if (!keep) this.campaign.variables = this.suggestVariables(t.components);
    this.changed();
  }

  /** A sensible first fill: {{1}} the first name, {{2}} the company — or a column with the variable's own name. */
  private suggestVariables(components: WaTemplateComponent[]): WaCampaign['variables'] {
    const slots = slotsOf(components);
    const guess = (name: string, i: number): string => {
      if (this.columns.includes(name)) return `{{${name}}}`;
      if (name === '1' || (i === 0 && !/^\d+$/.test(name))) return '{{first_name|Sir/Madam}}';
      if (name === '2') return '{{company|your company}}';
      return '';
    };
    const body: Record<string, string> = {};
    slots.body.forEach((n, i) => { body[n] = guess(n, i); });
    const header: Record<string, string> = {};
    slots.header.forEach((n) => { header[n] = guess(n, 1); });
    return { header, body, buttons: {} };
  }

  statusBadge(status: string): string {
    switch (status) {
      case 'APPROVED': return 'badge-ok';
      case 'PENDING': case 'IN_APPEAL': return 'badge-warn';
      case 'REJECTED': case 'DISABLED': case 'PAUSED': return 'badge-err';
      default: return 'badge-mute';
    }
  }

  statusWord(status: string): string {
    const words: Record<string, string> = {
      APPROVED: 'Approved', PENDING: 'Waiting for Meta', IN_APPEAL: 'In appeal', REJECTED: 'Rejected', PAUSED: 'Paused by Meta', DISABLED: 'Disabled'
    };
    return words[status] || status;
  }

  /** The template's message on one or two lines, for the list. */
  excerpt(t: WaTemplate): string {
    return (t.components.find((c) => c.type === 'BODY')?.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  insertColumn(target: 'header' | 'body' | 'buttons', key: string | number, column: string): void {
    const map = this.campaign.variables[target] as Record<string, string>;
    const fallback = column === 'first_name' ? 'Sir/Madam' : column === 'company' ? 'your company' : '';
    map[key] = fallback ? `{{${column}|${fallback}}}` : `{{${column}}}`;
    this.changed();
  }

  async onHeaderFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.campaign.tenant_id) return;
    this.headerUploading = true;
    try {
      const image = await prepareEmailImage(file, 'banner');
      this.service.uploadImage(this.campaign.tenant_id, image.blob).subscribe({
        next: (res) => {
          this.headerUploading = false;
          this.campaign.header_media_url = res.data.url;
          this.changed();
          this.toast.success('Picture added. Save to keep it.');
        },
        error: (err: HttpErrorResponse) => { this.headerUploading = false; this.fail(err, 'Could not upload the picture.'); }
      });
    } catch (err) {
      this.headerUploading = false;
      this.toast.error((err as Error).message);
    }
  }

  // --------------------------------------------------------------- preview --

  get sample(): Record<string, string> {
    const r = this.previewChoices.find((x) => x.id === this.previewRecipientId) || this.previewChoices[0];
    return r ? { ...r.data, phone: r.phone } : SAMPLE;
  }

  /** The chosen template filled in for the preview contact. */
  get bubble(): Bubble | null {
    const list = this.campaign.template_components;
    if (!list?.length) return null;
    const v = this.campaign.variables;
    const values = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, t]) => [k, merge(t, this.sample)]));
    return this.bubbleOf(list, values(v.header), values(v.body), this.campaign.header_media_url || '');
  }

  /** The template being written, filled in with its own examples. */
  get draftBubble(): Bubble {
    const d = this.draft;
    const components: WaTemplateComponent[] = [];
    if (d.header_format === 'TEXT') components.push({ type: 'HEADER', format: 'TEXT', text: d.header_text });
    if (d.header_format === 'IMAGE') components.push({ type: 'HEADER', format: 'IMAGE' });
    components.push({ type: 'BODY', text: d.body || 'Your message appears here.' });
    if (d.footer) components.push({ type: 'FOOTER', text: d.footer });
    if (d.buttons.length) components.push({ type: 'BUTTONS', buttons: d.buttons });
    return this.bubbleOf(components, {}, d.examples, d.header_image_url);
  }

  private bubbleOf(list: WaTemplateComponent[], header: Record<string, string>, body: Record<string, string>, media: string): Bubble {
    const h = list.find((c) => c.type === 'HEADER');
    return {
      headerFormat: h?.format || null,
      headerText: h?.format === 'TEXT' ? fill(h.text, header) : '',
      headerImage: media,
      body: this.sanitizer.bypassSecurityTrustHtml(waFormat(fill(list.find((c) => c.type === 'BODY')?.text, body))),
      footer: list.find((c) => c.type === 'FOOTER')?.text || '',
      buttons: (list.find((c) => c.type === 'BUTTONS')?.buttons || []).map((b) => ({ type: b.type, text: b.text }))
    };
  }

  private loadPreviewChoices(): void {
    if (!this.campaignId) return;
    this.service.recipients(this.campaignId, { page: 1, limit: 20 }).subscribe((res) => (this.previewChoices = res.data));
  }

  // ------------------------------------------------------ template creator --

  openCreator(): void {
    this.draft = blankDraft(this.campaign.name);
    this.creatorOpen = true;
  }

  useSample(): void {
    const s = sampleTemplate(this.account?.tenant_name || '');
    this.draft.body = s.body;
    this.draft.examples = s.examples;
    this.draft.footer = s.footer;
  }

  get draftVariables(): string[] { return variablesIn(this.draft.body); }

  wrap(area: HTMLTextAreaElement, mark: string): void {
    const { selectionStart: a, selectionEnd: b, value } = area;
    const picked = value.slice(a, b) || 'text';
    this.draft.body = `${value.slice(0, a)}${mark}${picked}${mark}${value.slice(b)}`;
    setTimeout(() => { area.focus(); area.setSelectionRange(a + 1, a + 1 + picked.length); });
  }

  addVariable(area: HTMLTextAreaElement): void {
    const next = this.draftVariables.filter((n) => /^\d+$/.test(n)).length + 1;
    const at = area.selectionStart ?? this.draft.body.length;
    this.draft.body = `${this.draft.body.slice(0, at)}{{${next}}}${this.draft.body.slice(at)}`;
    if (!this.draft.examples[next]) this.draft.examples[next] = next === 1 ? 'Ramesh' : next === 2 ? 'Linit Exports' : '';
    setTimeout(() => { area.focus(); area.setSelectionRange(at + 5, at + 5); });
  }

  addButton(type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'): void {
    if (this.draft.buttons.length >= 10) return;
    this.draft.buttons.push(type === 'URL' ? { type, text: 'Visit website', url: 'https://' }
      : type === 'PHONE_NUMBER' ? { type, text: 'Call us', phone_number: '+91' } : { type, text: '' });
  }

  hasButton(type: string): boolean { return this.draft.buttons.some((b) => b.type === type); }

  async onDraftImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.campaign.tenant_id) return;
    this.draftImageUploading = true;
    try {
      const image = await prepareEmailImage(file, 'banner');
      this.service.uploadImage(this.campaign.tenant_id, image.blob).subscribe({
        next: (res) => { this.draftImageUploading = false; this.draft.header_image_url = res.data.url; },
        error: (err: HttpErrorResponse) => { this.draftImageUploading = false; this.fail(err, 'Could not upload the picture.'); }
      });
    } catch (err) {
      this.draftImageUploading = false;
      this.toast.error((err as Error).message);
    }
  }

  submitTemplate(): void {
    if (!this.campaign.tenant_id) return;
    const d = this.draft;
    const examples: Record<string, string> = {};
    this.draftVariables.forEach((n) => { examples[n] = (d.examples[n] || '').trim(); });
    this.creating = true;
    this.service.createTemplate(this.campaign.tenant_id, {
      ...d,
      header_text: d.header_format === 'TEXT' ? d.header_text : '',
      header_image_url: d.header_format === 'IMAGE' ? d.header_image_url : '',
      examples,
      buttons: d.buttons.filter((b) => b.text.trim())
    }).subscribe({
      next: (res) => {
        this.creating = false;
        this.creatorOpen = false;
        this.toast.success(res.message || 'Sent to Meta.');
        this.loadTemplates();
      },
      error: (err: HttpErrorResponse) => { this.creating = false; this.fail(err, 'Meta did not accept the template.'); }
    });
  }

  // -------------------------------------------------------------- contacts --

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

  get recipientPages(): number[] {
    const { page, pages } = this.recipientPage;
    const start = Math.max(1, Math.min(page - 2, pages - 4));
    return Array.from({ length: Math.min(5, pages) }, (_, i) => start + i);
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

  uploadPasted(): void {
    const text = this.pasteText.trim();
    if (!text) return;
    this.uploadList(new Blob([text], { type: 'text/csv' }), 'pasted.csv');
  }

  private uploadList(file: Blob, filename: string): void {
    if (!this.campaignId) return;
    if (file.size > MAX_LIST_BYTES) { this.toast.error('The list is larger than 5 MB. Split it into smaller files.'); return; }
    this.uploading = true;
    this.service.uploadRecipients(this.campaignId, file, filename).subscribe({
      next: (res) => {
        this.uploading = false;
        this.pasteOpen = false;
        this.pasteText = '';
        this.importSummary = res.data;
        this.toast.success(`${res.data.imported.toLocaleString()} contact(s) imported.`);
        this.load();
        this.loadRecipients(false, 1);
        this.loadPreviewChoices();
      },
      error: (err: HttpErrorResponse) => { this.uploading = false; this.fail(err, 'Could not read the list.'); }
    });
  }

  downloadSample(): void {
    const csv = '﻿phone,first_name,company,city\n9840624198,Priya,Acme Textiles,Coimbatore\n+91 98211 61388,Nitin,Linit Exports,Mumbai\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'whatsapp-contacts-sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  clearList(): void {
    this.confirmClearOpen = false;
    this.service.clearRecipients(this.campaignId!).subscribe(() => {
      this.importSummary = null;
      this.toast.success('Contact list cleared.');
      this.load();
      this.loadRecipients(false, 1);
      this.previewChoices = [];
    });
  }

  canRemove(r: WaRecipient): boolean { return r.status === 'pending' || r.status === 'failed'; }

  removeRecipient(): void {
    const r = this.recipientToRemove;
    this.recipientToRemove = null;
    if (!r || !this.campaignId) return;
    this.service.removeRecipient(this.campaignId, r.id).subscribe({
      next: (res) => {
        this.toast.success(res.message || 'Removed.');
        this.recipients = this.recipients.filter((x) => x.id !== r.id);
        this.previewChoices = this.previewChoices.filter((x) => x.id !== r.id);
        this.load();
      },
      error: () => this.loadRecipients(true)
    });
  }

  nameOf(data: Record<string, string>): string {
    return data['first_name'] || data['name'] || data['contact_name'] || '';
  }

  exportResults(): void {
    this.service.exportRecipients(this.campaignId!).subscribe((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(this.campaign.name || 'whatsapp').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-results.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ----------------------------------------------------------------- send --

  get checks(): Check[] {
    const a = this.account;
    const t = this.chosen;
    const quality = a?.quality_rating;
    return [
      a?.connected
        ? { state: quality === 'RED' ? 'missing' : 'ok', label: 'WhatsApp number',
          detail: `${a.display_phone || a.tenant_name} · quality ${qualityOf(quality || null).label}`, step: 'details' }
        : { state: 'missing', label: 'WhatsApp number', detail: 'Not connected — open WhatsApp setup.', step: 'details' },
      a?.webhook_seen_at
        ? { state: 'ok', label: 'Replies & receipts', detail: 'Webhook working — replies come to the report and your email.' }
        : { state: 'warn', label: 'Replies & receipts', detail: 'Webhook not set up: messages send, but you will not see replies.' },
      !this.campaign.template_name
        ? { state: 'missing', label: 'Template', detail: 'Choose an approved template.', step: 'message' }
        : t && t.status !== 'APPROVED'
          ? { state: 'missing', label: 'Template', detail: `${this.statusWord(t.status)} — it can be sent once Meta approves it.`, step: 'message' }
          : { state: 'ok', label: 'Template', detail: `${this.campaign.template_name} · ${this.campaign.template_category || ''}`, step: 'message' },
      this.messageReady || !this.campaign.template_name
        ? { state: this.messageReady ? 'ok' : 'missing', label: 'Personal details', detail: this.messageReady ? 'Every variable is filled in.' : 'Fill in the template first.', step: 'message' }
        : { state: 'missing', label: 'Personal details', detail: 'Fill in every variable (and the header picture).', step: 'message' },
      this.stats.pending
        ? { state: 'ok', label: 'Contacts', detail: `${this.stats.pending.toLocaleString()} waiting`, step: 'contacts' }
        : { state: 'missing', label: 'Contacts', detail: this.stats.failed ? 'Nothing waiting — retry the failed ones from the report.' : 'Upload the contact list.', step: 'contacts' }
    ];
  }

  get canStart(): boolean {
    return !this.isNew && ['draft', 'paused', 'scheduled'].includes(this.campaign.status || '') && this.checks.every((c) => c.state !== 'missing');
  }

  get estimate(): string {
    const n = this.stats.pending;
    const p = this.campaign.pace;
    if (!n || !p) return '';
    const today = Math.max(0, p.daily_limit - p.last_24h);
    if (n > today) {
      const days = Math.ceil((n - today) / p.daily_limit) + (today ? 1 : 0);
      return days === 1 ? 'about a day' : `about ${days} days`;
    }
    const minutes = Math.round((n - 1) * p.gap_minutes);
    return minutes < 1 ? 'a moment' : minutes < 60 ? `about ${minutes} minutes` : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  /** "{{1}}" — a template slot as WhatsApp writes it. */
  slot(name: string | number): string { return `{{${name}}}`; }

  /** A slot's merge text, filled in for the preview contact. */
  filled(template: string | undefined): string { return merge(template || '', this.sample); }

  get paceSentence(): string {
    const text = this.paceText;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  get paceText(): string {
    const p = this.campaign.pace;
    if (!p) return '';
    const gap = p.gap_minutes >= 1 ? `${+p.gap_minutes.toFixed(1)} minute${p.gap_minutes === 1 ? '' : 's'}` : `${Math.round(p.gap_minutes * 60)} seconds`;
    return `one message every ${gap}, at most ${p.daily_limit} a day`;
  }

  get minSchedule(): string {
    const d = new Date(Date.now() + 5 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  sendTest(): void {
    const to = this.testTo.trim();
    if (!to || !this.campaignId) return;
    try { localStorage.setItem('cm_wa_test_to', to); } catch { /* private mode */ }
    this.testing = true;
    this.service.sendTest(this.campaignId, { ...this.payload(), to }).subscribe({
      next: (res) => { this.testing = false; this.toast.success(res.message || 'Test sent.'); },
      error: (err: HttpErrorResponse) => { this.testing = false; this.fail(err, 'Test not sent.'); }
    });
  }

  askStart(): void {
    if (this.when === 'later' && !this.scheduleAt) { this.toast.error('Choose when to send.'); return; }
    this.confirmStartOpen = true;
  }

  start(): void {
    this.confirmStartOpen = false;
    const go = this.dirty ? this.persist() : of(this.campaign);
    this.acting = true;
    go.subscribe((saved) => {
      if (!saved) { this.acting = false; return; }
      const scheduled = this.when === 'later' && this.scheduleAt ? new Date(this.scheduleAt).toISOString() : null;
      this.service.start(this.campaignId!, { consent: this.consent, scheduled_at: scheduled }).subscribe({
        next: (res) => {
          this.acting = false;
          this.toast.success(res.message || 'Started.');
          this.step = 'report';
          this.load();
          this.loadRecipients(false, 1);
          this.loadConversations();
        },
        error: (err: HttpErrorResponse) => { this.acting = false; this.fail(err, 'Could not start.'); }
      });
    });
  }

  resume(): void {
    this.acting = true;
    this.service.start(this.campaignId!, { consent: true }).subscribe({
      next: (res) => { this.acting = false; this.toast.success(res.message || 'Resumed.'); this.load(); },
      error: (err: HttpErrorResponse) => { this.acting = false; this.fail(err, 'Could not resume.'); }
    });
  }

  private act(request: Observable<ApiResponse<null>>, fallback: string): void {
    this.acting = true;
    request.subscribe({
      next: (res) => { this.acting = false; this.toast.success(res.message || fallback); this.load(); this.loadRecipients(true); },
      error: () => { this.acting = false; }
    });
  }

  pause(): void { this.act(this.service.pause(this.campaignId!), 'Paused.'); }
  cancelCampaign(): void { this.confirmCancelOpen = false; this.act(this.service.cancel(this.campaignId!), 'Cancelled.'); }
  retryFailed(): void { this.act(this.service.retryFailed(this.campaignId!), 'Queued again.'); }

  duplicate(): void {
    this.service.duplicate(this.campaignId!).subscribe((res) => {
      this.toast.success(res.message || 'Copied.');
      this.router.navigate(['/whatsapp', res.data.id]);
    });
  }

  remove(): void {
    this.confirmDeleteOpen = false;
    this.service.remove(this.campaignId!).subscribe(() => {
      this.toast.success('Campaign deleted.');
      this.router.navigate(['/whatsapp']);
    });
  }

  share(count: number): number {
    return this.stats.total ? (count / this.stats.total) * 100 : 0;
  }

  // --------------------------------------------------------------- replies --

  loadConversations(): void {
    if (!this.campaignId) return;
    this.service.conversations(this.campaignId).subscribe((data) => (this.conversations = data));
  }

  toggleThread(phone: string): void {
    this.openThread = this.openThread === phone ? null : phone;
  }

  sendReply(c: WaConversation): void {
    const text = (this.replyText[c.phone] || '').trim();
    if (!text) return;
    this.replying = true;
    this.service.reply(this.campaignId!, c.phone, text).subscribe({
      next: (res) => {
        this.replying = false;
        this.replyText[c.phone] = '';
        this.toast.success(res.message || 'Reply sent.');
        this.loadConversations();
      },
      error: (err: HttpErrorResponse) => { this.replying = false; this.fail(err, 'Reply not sent.'); }
    });
  }

  lastMessage(c: WaConversation): string {
    return c.messages.length ? c.messages[c.messages.length - 1].body : '';
  }

  // --------------------------------------------------------------- helpers --

  private syncPolling(): void {
    const live = this.campaign.status === 'sending' || this.campaign.status === 'scheduled';
    if (live && !this.poll) {
      this.poll = interval(5000).subscribe(() => {
        this.service.get(this.campaignId!).subscribe({
          next: (data) => {
            Object.assign(this.campaign, {
              status: data.status, status_reason: data.status_reason, next_send_at: data.next_send_at, stats: data.stats,
              pace: data.pace, editable: data.editable, account: data.account
            });
            if (this.step === 'report' || this.step === 'contacts') this.loadRecipients(true);
            if (!(data.status === 'sending' || data.status === 'scheduled')) this.syncPolling();
          },
          error: () => { this.poll?.unsubscribe(); this.poll = undefined; }
        });
      });
    }
    if (!live && this.poll) { this.poll.unsubscribe(); this.poll = undefined; }

    const wantReplies = this.step === 'report';
    if (wantReplies && !this.replyPoll) this.replyPoll = interval(15000).subscribe(() => this.loadConversations());
    if (!wantReplies && this.replyPoll) { this.replyPoll.unsubscribe(); this.replyPoll = undefined; }
  }

  /** Anything but a 400 has already been shown by the interceptor. */
  private fail(err: HttpErrorResponse, fallback: string): void {
    if (err.status !== 400) return;
    const errors: { message: string }[] = err.error?.errors || [];
    this.toast.error(errors.length ? errors.map((e) => e.message).join('\n') : (err.error?.message || fallback));
  }
}
