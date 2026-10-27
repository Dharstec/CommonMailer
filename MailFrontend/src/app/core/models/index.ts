export interface ApiResponse<T> {
  status: 'success' | 'error';
  message?: string;
  data: T;
  errors?: { field: string; message: string }[];
  pagination?: Pagination;
  defaults?: Record<string, EmailTemplate>;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: string;
  last_login_at?: string;
}

export interface Tenant {
  id?: number;
  name: string;
  slug: string;
  website_url?: string | null;
  contact_email?: string | null;
  notes?: string | null;
  is_active: boolean;
  form_count?: number;
  smtp_configured?: boolean;
  smtp_verified_at?: string | null;
  smtp?: TenantSmtp | null;
  created_at?: string;
}

/** `password` is write-only: the API never sends it back, blank means "keep". */
export interface TenantSmtp {
  id?: number;
  tenant_id?: number;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string;
  from_name: string;
  from_email: string;
  reply_to?: string | null;
  is_active: boolean;
  verified_at?: string | null;
}

export type FieldType =
  | 'text' | 'email' | 'tel' | 'number' | 'textarea' | 'select'
  | 'radio' | 'checkbox' | 'checkbox_group' | 'date' | 'url' | 'hidden';

export interface FieldOption {
  label: string;
  value: string;
}

export interface FormField {
  id?: number | null;
  field_key: string;
  label: string;
  field_type: FieldType;
  placeholder?: string | null;
  help_text?: string | null;
  default_value?: string | null;
  is_required: boolean;
  min_length?: number | null;
  max_length?: number | null;
  min_value?: number | null;
  max_value?: number | null;
  pattern?: string | null;
  pattern_message?: string | null;
  options: FieldOption[];
  textarea_rows: number;
  col_span: number;
  sort_order: number;
  is_active: boolean;
}

export interface ContactForm {
  id?: number;
  tenant_id: number | null;
  tenant_name?: string;
  form_key: string;
  name: string;
  description?: string | null;

  recipients: string[];
  cc: string[];
  bcc: string[];
  allowed_origins: string[];

  title?: string | null;
  intro_text?: string | null;
  submit_button_text: string;
  success_message: string;
  layout_columns: number;

  honeypot_field: string;
  min_submit_seconds: number;
  max_per_hour_per_ip: number;
  require_origin: boolean;
  duplicate_window_minutes: number;
  content_filter_enabled: boolean;
  recaptcha_enabled: boolean;
  recaptcha_site_key?: string | null;
  recaptcha_secret?: string | null;
  recaptcha_secret_configured?: boolean;
  recaptcha_min_score: number;

  autoreply_enabled: boolean;
  autoreply_to_field?: string | null;

  store_submissions: boolean;
  is_active: boolean;

  fields: FormField[];
  templates?: EmailTemplate[];
  links?: FormLinks;
  field_count?: number;
  submission_count?: number;
  created_at?: string;
}

/** The single URL a customer website posts to, returned by the API. */
export interface FormLinks {
  submit_url: string;
}

export interface EmailTemplate {
  id?: number;
  form_id?: number;
  template_type: 'admin' | 'autoreply';
  subject: string;
  html_body: string;
  text_body?: string | null;
  is_active: boolean;
}

export interface Submission {
  id: number;
  form_id: number;
  tenant_id: number;
  data: Record<string, any>;
  ip?: string;
  user_agent?: string;
  referer?: string;
  origin?: string;
  mail_status: 'pending' | 'sent' | 'failed' | 'spam';
  mail_error?: string | null;
  spam_reason?: string | null;
  created_at: string;
  form_name?: string;
  tenant_name?: string;
  fields?: FormField[];
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled';
export type CampaignDesign = 'executive' | 'spotlight' | 'aurora' | 'personal' | 'custom';
export type RecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

/** The structured fields a design renders. Custom HTML campaigns use custom_html instead. */
export interface CampaignContent {
  brand_color?: string | null;
  logo_url?: string | null;
  logo_width?: number | null;
  hero_image_url?: string | null;
  headline?: string | null;
  body?: string | null;
  cta_text?: string | null;
  cta_url?: string | null;
  signature?: string | null;
  footer_text?: string | null;
}

export interface CampaignStats {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
  opened: number;
  unsubscribed: number;
}

export interface CampaignAttachment {
  id: number;
  filename: string;
  content_type?: string | null;
  size_bytes: number;
  created_at?: string;
}

/** What the last recipient upload contained — kept so the panel can show it again later. */
export interface ImportSummary {
  filename?: string | null;
  total_rows: number;
  imported: number;
  invalid_count: number;
  invalid: { row: number; value: string; reason: string }[];
  duplicates: number;
  suppressed: number;
  columns: string[];
  uploaded_at?: string;
}

/** The customer's SMTP account as the campaign will use it. */
export interface CampaignSender {
  configured: boolean;
  verified: boolean;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
}

export interface Campaign {
  id?: number;
  tenant_id: number | null;
  tenant_name?: string;
  name: string;
  status?: CampaignStatus;

  from_name?: string | null;
  from_email?: string | null;
  reply_to?: string | null;
  subject: string;
  preheader?: string | null;

  design: CampaignDesign;
  content: CampaignContent;
  custom_html?: string | null;

  columns?: string[];
  import_summary?: ImportSummary | null;

  track_opens: boolean;
  rate_per_minute: number;
  daily_limit: number;
  scheduled_at?: string | null;
  next_send_at?: string | null;
  status_reason?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;

  stats?: CampaignStats;
  attachments?: CampaignAttachment[];
  sender?: CampaignSender;
  editable?: { content: boolean; recipients: boolean };
}

export interface CampaignRecipient {
  id: number;
  email: string;
  data: Record<string, string>;
  status: RecipientStatus;
  error?: string | null;
  attempted_at?: string | null;
  sent_at?: string | null;
  opened_at?: string | null;
  open_count: number;
  unsubscribed_at?: string | null;
}

export interface CampaignPreview {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  from_name: string;
  from_email: string;
  to: string;
  recipient_id: number | null;
  sample: boolean;
}

export interface CampaignUnsubscribe {
  id: number;
  email: string;
  source: 'link' | 'one_click' | 'manual';
  campaign_name?: string | null;
  created_at: string;
}

export interface DashboardStats {
  active_tenants: number;
  active_forms: number;
  submissions_30d: number;
  failed_30d: number;
  spam_30d: number;
  recent: Submission[];
  daily: { day: string; total: number }[];
}
