import { Component, OnInit } from '@angular/core';
import { FormArray, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { FormService, TenantService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import { ContactForm, EmailTemplate, FieldType, FormField, FormLinks, Tenant } from '../../core/models';
import { environment } from 'src/environments/environment';

interface FieldTypeMeta {
  value: FieldType;
  label: string;
  hasOptions: boolean;
}

/** The one field every form must have, on every customer. */
export const EMAIL_FIELD_KEY = 'email';

const EMAIL_FIELD: Partial<FormField> = {
  field_key: EMAIL_FIELD_KEY, label: 'Email', field_type: 'email', is_required: true
};

/**
 * Starter layouts so a standard form is one click, not ten. Each begins with the
 * locked email field, matching what the backend enforces on save.
 */
const PRESETS: Record<string, Partial<FormField>[]> = {
  contact: [
    EMAIL_FIELD,
    { field_key: 'name', label: 'Name', field_type: 'text', is_required: true, max_length: 100 },
    { field_key: 'purpose', label: 'Purpose', field_type: 'textarea', is_required: true, max_length: 2000 }
  ],
  enquiry: [
    EMAIL_FIELD,
    { field_key: 'name', label: 'Name', field_type: 'text', is_required: true },
    { field_key: 'phone', label: 'Phone', field_type: 'tel', is_required: false },
    { field_key: 'message', label: 'Message', field_type: 'textarea', is_required: true }
  ],
  information: [
    EMAIL_FIELD,
    { field_key: 'name', label: 'Name', field_type: 'text', is_required: true }
  ]
};

@Component({
  selector: 'app-form-builder',
  templateUrl: './form-builder.component.html'
})
export class FormBuilderComponent implements OnInit {
  formId: number | null = null;
  tenants: Tenant[] = [];
  loading = false;
  saving = false;
  tab: 'settings' | 'fields' | 'security' | 'templates' | 'api' = 'settings';
  links: FormLinks | null = null;

  templates: EmailTemplate[] = [];
  activeTemplate: EmailTemplate | null = null;
  previewHtml = '';
  previewSubject = '';
  templateTestEmail = '';
  savingTemplate = false;

  readonly presetNames = Object.keys(PRESETS);

  /**
   * Placeholder text is built here rather than written in the template: Angular
   * decodes HTML entities before parsing, so a literal `{{` in the HTML — however
   * it is escaped — is read as an interpolation and fails to compile.
   */
  readonly allFieldsToken = '{{#all_fields}}';
  token(key: string): string { return `{{${key}}}`; }
  readonly fieldTypes: FieldTypeMeta[] = [
    { value: 'text', label: 'Single line text', hasOptions: false },
    { value: 'email', label: 'Email address', hasOptions: false },
    { value: 'tel', label: 'Phone number', hasOptions: false },
    { value: 'number', label: 'Number', hasOptions: false },
    { value: 'textarea', label: 'Paragraph', hasOptions: false },
    { value: 'select', label: 'Dropdown', hasOptions: true },
    { value: 'radio', label: 'Radio buttons', hasOptions: true },
    { value: 'checkbox', label: 'Single checkbox', hasOptions: false },
    { value: 'checkbox_group', label: 'Checkbox group', hasOptions: true },
    { value: 'date', label: 'Date', hasOptions: false },
    { value: 'url', label: 'Website URL', hasOptions: false },
    { value: 'hidden', label: 'Hidden value', hasOptions: false }
  ];

  readonly form = this.fb.group({
    tenant_id: [null as number | null, Validators.required],
    form_key: ['', [Validators.required, Validators.pattern(/^[a-z0-9][a-z0-9-]*$/)]],
    name: ['', Validators.required],
    description: [''],

    recipients_text: ['', Validators.required],
    cc_text: [''],
    bcc_text: [''],
    origins_text: [''],

    title: [''],
    intro_text: [''],
    submit_button_text: ['Send Message', Validators.required],
    success_message: ['Thank you. Your message has been sent.', Validators.required],
    layout_columns: [1],

    honeypot_field: ['website_url_hp', Validators.required],
    min_submit_seconds: [3],
    max_per_hour_per_ip: [5],
    recaptcha_enabled: [false],
    recaptcha_site_key: [''],
    recaptcha_secret: [''],
    recaptcha_min_score: [0.5],

    autoreply_enabled: [false],
    autoreply_to_field: [''],

    store_submissions: [true],
    is_active: [true],

    fields: this.fb.array([] as FormGroup[])
  });

  constructor(
    private fb: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private service: FormService,
    private tenantService: TenantService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.tenantService.list().subscribe((data) => (this.tenants = data));

    const param = this.route.snapshot.paramMap.get('id');
    if (param && param !== 'new') {
      this.formId = Number(param);
      this.load();
    } else {
      const preselected = this.route.snapshot.queryParamMap.get('tenant');
      if (preselected) this.form.patchValue({ tenant_id: Number(preselected) });
      this.applyPreset('contact');
    }
  }

  get isNew(): boolean { return this.formId === null; }
  get fields(): FormArray { return this.form.get('fields') as FormArray; }

  /** Email fields are the only valid auto-reply targets. */
  get emailFields(): FormGroup[] {
    return (this.fields.controls as FormGroup[]).filter((g) => g.value.field_type === 'email');
  }

  /**
   * The email field is fixed: it cannot be removed, renamed, retyped or made
   * optional. The backend rejects a save that breaks any of those, so the panel
   * disables the controls rather than letting someone hit a wall on save.
   */
  isEmailField(group: FormGroup): boolean {
    return group.value.field_key === EMAIL_FIELD_KEY;
  }

  /** Puts the locked email field back if a loaded form somehow lacks it. */
  private ensureEmailField(): void {
    const has = (this.fields.controls as FormGroup[]).some((g) => this.isEmailField(g));
    if (!has) this.fields.insert(0, this.buildFieldGroup(EMAIL_FIELD));
  }

  /**
   * The API is the source of truth once a form is saved. Before that there is no
   * form_key on the server yet, so the panel previews the URL from the key being
   * typed.
   */
  get submitUrl(): string {
    if (this.links) return this.links.submit_url;
    return `${environment.publicBaseUrl}/api/form/${this.form.value.form_key || 'your-form-key'}`;
  }

  /** Live sample body, built from the fields currently in the builder. */
  get sampleBody(): string {
    const sample: Record<string, any> = {};
    for (const group of this.fields.controls as FormGroup[]) {
      const f = group.value;
      if (!f.field_key || f.is_active === false) continue;
      switch (f.field_type) {
        case 'email': sample[f.field_key] = 'info@gmail.com'; break;
        case 'tel': sample[f.field_key] = '9876543210'; break;
        case 'number': sample[f.field_key] = 10; break;
        case 'date': sample[f.field_key] = '2026-08-15'; break;
        case 'url': sample[f.field_key] = 'https://example.com'; break;
        case 'checkbox': sample[f.field_key] = true; break;
        case 'checkbox_group': sample[f.field_key] = (f.options || []).slice(0, 2).map((o: any) => o.value); break;
        case 'select':
        case 'radio': sample[f.field_key] = (f.options || [])[0]?.value || 'option_1'; break;
        default: sample[f.field_key] = 'test';
      }
    }
    return JSON.stringify(sample, null, 2);
  }

  /** Ready-to-paste HTML for the customer's static site. */
  get sampleHtml(): string {
    const inputs = (this.fields.controls as FormGroup[])
      .filter((g) => g.value.field_key && g.value.is_active !== false)
      .map((g) => {
        const f = g.value;
        const req = f.is_required ? ' required' : '';
        if (f.field_type === 'textarea') {
          return `  <label>${f.label}</label>\n  <textarea name="${f.field_key}"${req}></textarea>`;
        }
        if (f.field_type === 'select' || f.field_type === 'radio') {
          const opts = (f.options || []).map((o: any) => `    <option value="${o.value}">${o.label}</option>`).join('\n');
          return `  <label>${f.label}</label>\n  <select name="${f.field_key}"${req}>\n${opts}\n  </select>`;
        }
        const type = ['email', 'tel', 'number', 'date', 'url'].includes(f.field_type) ? f.field_type : 'text';
        return `  <label>${f.label}</label>\n  <input type="${type}" name="${f.field_key}"${req}>`;
      }).join('\n\n');

    return `<form id="cm-form">
${inputs}

  <button type="submit">Send</button>
  <p id="cm-msg"></p>
</form>

<script>
document.getElementById('cm-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());

  const res = await fetch('${this.submitUrl}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const out = await res.json();

  document.getElementById('cm-msg').textContent = out.message;
  if (out.status === 'success') e.target.reset();
});
</script>`;
  }

  /** Literal JSON samples — kept off the template so Angular does not try to
   *  interpolate the braces. */
  get successSample(): string {
    return JSON.stringify({ status: 'success', message: this.form.value.success_message }, null, 2);
  }

  get errorSample(): string {
    return JSON.stringify({
      status: 'error',
      message: 'Please correct the highlighted fields.',
      errors: [{ field: 'email', message: 'Email must be a valid email address' }]
    }, null, 2);
  }

  copy(text: string, label: string): void {
    navigator.clipboard.writeText(text).then(
      () => this.toast.success(`${label} copied.`),
      () => this.toast.error('Could not copy — select the text and copy manually.')
    );
  }

  typeMeta(type: FieldType): FieldTypeMeta | undefined {
    return this.fieldTypes.find((t) => t.value === type);
  }

  hasOptions(group: FormGroup): boolean {
    return Boolean(this.typeMeta(group.value.field_type)?.hasOptions);
  }

  // ---------------------------------------------------------------- fields --

  private buildFieldGroup(field: Partial<FormField> = {}): FormGroup {
    return this.fb.group({
      id: [field.id ?? null],
      field_key: [field.field_key || '', [Validators.required, Validators.pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/)]],
      label: [field.label || '', Validators.required],
      field_type: [field.field_type || 'text'],
      placeholder: [field.placeholder || ''],
      help_text: [field.help_text || ''],
      default_value: [field.default_value || ''],
      is_required: [field.is_required ?? false],
      min_length: [field.min_length ?? null],
      max_length: [field.max_length ?? null],
      min_value: [field.min_value ?? null],
      max_value: [field.max_value ?? null],
      pattern: [field.pattern || ''],
      pattern_message: [field.pattern_message || ''],
      options: this.fb.array((field.options || []).map((o) => this.fb.group({
        label: [o.label, Validators.required],
        value: [o.value, Validators.required]
      }))),
      textarea_rows: [field.textarea_rows ?? 4],
      col_span: [field.col_span ?? 1],
      sort_order: [field.sort_order ?? this.fields.length],
      is_active: [field.is_active ?? true],
      expanded: [false]
    });
  }

  optionsOf(group: FormGroup): FormArray { return group.get('options') as FormArray; }

  addField(): void {
    const group = this.buildFieldGroup({ sort_order: this.fields.length });
    group.patchValue({ expanded: true });
    this.fields.push(group);
    this.tab = 'fields';
  }

  removeField(index: number): void {
    if (this.isEmailField(this.fields.at(index) as FormGroup)) {
      this.toast.error('The email field is required on every form and cannot be removed.');
      return;
    }
    this.fields.removeAt(index);
    this.resequence();
  }

  moveField(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= this.fields.length) return;
    const control = this.fields.at(index);
    this.fields.removeAt(index);
    this.fields.insert(target, control);
    this.resequence();
  }

  private resequence(): void {
    this.fields.controls.forEach((c, i) => c.patchValue({ sort_order: i }, { emitEvent: false }));
  }

  addOption(group: FormGroup): void {
    this.optionsOf(group).push(this.fb.group({ label: ['', Validators.required], value: ['', Validators.required] }));
  }

  removeOption(group: FormGroup, index: number): void {
    this.optionsOf(group).removeAt(index);
  }

  /** Keeps `value` in step with `label` until someone edits it directly. */
  onOptionLabel(optionGroup: FormGroup): void {
    const label = optionGroup.value.label || '';
    if (!optionGroup.get('value')?.dirty) {
      optionGroup.patchValue({ value: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') },
        { emitEvent: false });
    }
  }

  onFieldLabel(group: FormGroup): void {
    if (this.isEmailField(group)) return;
    if (group.get('field_key')?.dirty) return;
    const key = (group.value.label || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
    group.patchValue({ field_key: key }, { emitEvent: false });
  }

  applyPreset(name: string): void {
    const preset = PRESETS[name];
    if (!preset) return;
    this.fields.clear();
    preset.forEach((f, i) => this.fields.push(this.buildFieldGroup({ ...f, sort_order: i })));
    this.ensureEmailField();
    this.form.patchValue({ autoreply_to_field: EMAIL_FIELD_KEY });
  }

  onNameChange(): void {
    if (!this.isNew || this.form.get('form_key')?.dirty) return;
    const key = (this.form.value.name || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    this.form.patchValue({ form_key: key }, { emitEvent: false });
  }

  // ------------------------------------------------------------------ load --

  private load(): void {
    this.loading = true;
    this.service.get(this.formId!).subscribe({
      next: (data: ContactForm) => {
        this.form.patchValue({
          tenant_id: data.tenant_id,
          form_key: data.form_key,
          name: data.name,
          description: data.description || '',
          recipients_text: (data.recipients || []).join('\n'),
          cc_text: (data.cc || []).join('\n'),
          bcc_text: (data.bcc || []).join('\n'),
          origins_text: (data.allowed_origins || []).join('\n'),
          title: data.title || '',
          intro_text: data.intro_text || '',
          submit_button_text: data.submit_button_text,
          success_message: data.success_message,
          layout_columns: data.layout_columns,
          honeypot_field: data.honeypot_field,
          min_submit_seconds: data.min_submit_seconds,
          max_per_hour_per_ip: data.max_per_hour_per_ip,
          recaptcha_enabled: data.recaptcha_enabled,
          recaptcha_site_key: data.recaptcha_site_key || '',
          recaptcha_min_score: Number(data.recaptcha_min_score),
          autoreply_enabled: data.autoreply_enabled,
          autoreply_to_field: data.autoreply_to_field || '',
          store_submissions: data.store_submissions,
          is_active: data.is_active
        });

        this.fields.clear();
        (data.fields || []).forEach((f) => this.fields.push(this.buildFieldGroup(f)));
        this.ensureEmailField();

        this.templates = data.templates || [];
        this.activeTemplate = this.templates.find((t) => t.template_type === 'admin') || null;
        this.links = data.links || null;
        this.loading = false;
      },
      error: () => { this.loading = false; }
    });
  }

  // ------------------------------------------------------------------ save --

  private linesToArray(value: string | null | undefined): string[] {
    return (value || '')
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private buildPayload(): ContactForm {
    const raw = this.form.value as any;
    return {
      tenant_id: raw.tenant_id,
      form_key: raw.form_key,
      name: raw.name,
      description: raw.description || null,
      recipients: this.linesToArray(raw.recipients_text),
      cc: this.linesToArray(raw.cc_text),
      bcc: this.linesToArray(raw.bcc_text),
      allowed_origins: this.linesToArray(raw.origins_text),
      title: raw.title || null,
      intro_text: raw.intro_text || null,
      submit_button_text: raw.submit_button_text,
      success_message: raw.success_message,
      layout_columns: Number(raw.layout_columns),
      honeypot_field: raw.honeypot_field,
      min_submit_seconds: Number(raw.min_submit_seconds),
      max_per_hour_per_ip: Number(raw.max_per_hour_per_ip),
      recaptcha_enabled: raw.recaptcha_enabled,
      recaptcha_site_key: raw.recaptcha_site_key || null,
      recaptcha_secret: raw.recaptcha_secret || null,
      recaptcha_min_score: Number(raw.recaptcha_min_score),
      autoreply_enabled: raw.autoreply_enabled,
      autoreply_to_field: raw.autoreply_to_field || null,
      store_submissions: raw.store_submissions,
      is_active: raw.is_active,
      fields: (raw.fields || []).map((f: any, index: number) => ({
        field_key: f.field_key,
        label: f.label,
        field_type: f.field_type,
        placeholder: f.placeholder || null,
        help_text: f.help_text || null,
        default_value: f.default_value || null,
        is_required: f.is_required,
        min_length: f.min_length === '' ? null : f.min_length,
        max_length: f.max_length === '' ? null : f.max_length,
        min_value: f.min_value === '' ? null : f.min_value,
        max_value: f.max_value === '' ? null : f.max_value,
        pattern: f.pattern || null,
        pattern_message: f.pattern_message || null,
        options: this.typeMeta(f.field_type)?.hasOptions ? f.options : [],
        textarea_rows: Number(f.textarea_rows),
        col_span: Number(f.col_span),
        sort_order: index,
        is_active: f.is_active
      }))
    };
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      // Send the user to the tab that actually contains the problem.
      this.tab = this.fields.invalid ? 'fields' : 'settings';
      this.toast.error('Please correct the highlighted fields.');
      return;
    }
    if (this.fields.length === 0) {
      this.tab = 'fields';
      this.toast.error('Add at least one field.');
      return;
    }

    this.saving = true;
    const payload = this.buildPayload();
    const request = this.isNew ? this.service.create(payload) : this.service.update(this.formId!, payload);

    request.subscribe({
      next: (res) => {
        this.saving = false;
        this.toast.success(this.isNew ? 'Form created.' : 'Form saved.');
        this.form.patchValue({ recaptcha_secret: '' });
        if (res.data?.links) this.links = res.data.links;
        if (this.isNew && res.data?.id) {
          this.router.navigate(['/forms', res.data.id], { replaceUrl: true });
          this.formId = res.data.id;
          this.load();
        }
      },
      error: (err) => {
        this.saving = false;
        const errors = err.error?.errors;
        if (errors?.length) {
          this.toast.error(errors.map((e: any) => e.message).join(' · '));
        } else {
          this.toast.error(err.error?.message || 'Could not save the form.');
        }
      }
    });
  }


  // -------------------------------------------------------------- templates --

  selectTemplate(type: 'admin' | 'autoreply'): void {
    this.activeTemplate = this.templates.find((t) => t.template_type === type) || {
      template_type: type, subject: '', html_body: '', text_body: '', is_active: true
    };
    this.previewHtml = '';
  }

  saveTemplate(): void {
    if (!this.activeTemplate || !this.formId) return;
    this.savingTemplate = true;
    this.service.saveTemplate(this.formId, this.activeTemplate).subscribe({
      next: (res) => {
        this.savingTemplate = false;
        const index = this.templates.findIndex((t) => t.template_type === this.activeTemplate!.template_type);
        if (index >= 0) this.templates[index] = res.data; else this.templates.push(res.data);
        this.toast.success('Template saved.');
      },
      error: (err) => {
        this.savingTemplate = false;
        this.toast.error(err.error?.message || 'Could not save the template.');
      }
    });
  }

  previewTemplate(): void {
    if (!this.activeTemplate || !this.formId) return;
    this.service.previewTemplate(this.formId, this.activeTemplate).subscribe({
      next: (res) => {
        this.previewSubject = res.data.subject;
        this.previewHtml = res.data.html;
      }
    });
  }

  sendTemplateTest(): void {
    if (!this.activeTemplate || !this.formId) return;
    if (!this.templateTestEmail) {
      this.toast.error('Enter an email address to send the test to.');
      return;
    }
    this.service.sendTestTemplate(this.formId, this.templateTestEmail, this.activeTemplate.template_type).subscribe({
      next: (res) => this.toast.success(res.message || 'Test sent.'),
      error: (err) => this.toast.error(err.error?.message || 'Could not send the test.')
    });
  }

  insertPlaceholder(key: string): void {
    if (!this.activeTemplate) return;
    this.activeTemplate.html_body = `${this.activeTemplate.html_body || ''}{{${key}}}`;
  }
}
