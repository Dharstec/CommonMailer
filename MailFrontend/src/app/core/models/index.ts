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

/** How fast the sending mailbox may go — set on the server, shared by all its campaigns. */
export interface CampaignPace {
  gap_minutes: number;
  daily_limit: number;
  /** Campaign emails this mailbox handed to its server in the last 24 hours. */
  last_24h: number;
}

/** Sending hours: days 0 = Sunday, times on the zone's own clock. null sends at any time. */
export interface SendWindow {
  start: string;
  end: string;
  days: number[];
  tz: string;
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
  send_window?: SendWindow | null;
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
  pace?: CampaignPace;
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

// -------------------------------------------------------------- WhatsApp --

export type WaQuality = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN' | string | null;

/** A customer and whether its WhatsApp number is connected — for the pickers. */
export interface WaAccountSummary {
  tenant_id: number;
  tenant_name: string;
  connected: boolean;
  display_phone: string | null;
  verified_name: string | null;
  quality_rating: WaQuality;
  messaging_limit: string | null;
  webhook_seen_at: string | null;
  smtp_ready: boolean;
}

/** The saved connection, without the token or app secret. */
export interface WaAccount {
  phone_number_id: string;
  waba_id: string;
  app_id: string | null;
  default_country: string;
  notify_emails: string | null;
  display_phone: string | null;
  verified_name: string | null;
  quality_rating: WaQuality;
  messaging_limit: string | null;
  checked_at: string | null;
  webhook_seen_at: string | null;
  has_token: boolean;
  has_app_secret: boolean;
}

export interface WaAccountDetail {
  tenant_id: number;
  tenant_name: string;
  connected: boolean;
  account: WaAccount | null;
  webhook: { url: string; verify_token: string } | null;
  pace: CampaignPace;
}

export interface WaAccountForm {
  phone_number_id: string;
  waba_id: string;
  app_id: string;
  access_token: string;
  app_secret: string;
  default_country: string;
  notify_emails: string;
}

export interface WaNumberInfo {
  display_phone: string | null;
  verified_name: string | null;
  quality_rating: WaQuality;
  messaging_limit: string | null;
  name_status?: string | null;
}

export interface WaTemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | string;
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | string;
  text?: string;
  buttons?: { type: string; text: string; url?: string; phone_number?: string }[];
  example?: unknown;
}

export interface WaTemplate {
  id: string;
  name: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED' | string;
  category: string;
  language: string;
  components: WaTemplateComponent[];
  parameter_format: 'POSITIONAL' | 'NAMED' | string;
  rejected_reason: string | null;
  quality: string | null;
}

export interface WaTemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
  text: string;
  url?: string;
  phone_number?: string;
}

export interface WaTemplateDraft {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  language: string;
  header_format: 'NONE' | 'TEXT' | 'IMAGE';
  header_text: string;
  header_image_url: string;
  body: string;
  examples: Record<string, string>;
  footer: string;
  buttons: WaTemplateButton[];
}

/** What fills each {{slot}} of the template: merge text such as "{{first_name|Sir/Madam}}". */
export interface WaVariables {
  header: Record<string, string>;
  body: Record<string, string>;
  buttons: Record<string, string>;
}

export interface WaStats {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  replied: number;
}

export interface WaImportSummary {
  filename: string | null;
  total_rows: number;
  imported: number;
  invalid_count: number;
  invalid: { row: number; value: string; reason: string }[];
  duplicates: number;
  suppressed: number;
  country: string;
  columns: string[];
}

export interface WaCampaign {
  id?: number;
  tenant_id: number | null;
  tenant_name?: string;
  name: string;
  status?: CampaignStatus;
  template_name: string | null;
  template_language: string | null;
  template_category: string | null;
  template_format: string | null;
  template_components: WaTemplateComponent[] | null;
  variables: WaVariables;
  header_media_url: string | null;
  send_window?: SendWindow | null;
  columns?: string[];
  import_summary?: WaImportSummary | null;
  scheduled_at?: string | null;
  next_send_at?: string | null;
  status_reason?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  display_phone?: string | null;
  stats?: WaStats;
  account?: Partial<WaAccount> & { connected: boolean };
  pace?: CampaignPace;
  editable?: { content: boolean; recipients: boolean };
}

export type WaRecipientStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';

export interface WaRecipient {
  id: number;
  phone: string;
  phone_display: string;
  data: Record<string, string>;
  status: WaRecipientStatus;
  error?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  replied_at?: string | null;
}

export interface WaMessage {
  id: number;
  direction: 'in' | 'out';
  body: string;
  created_at: string;
}

export interface WaConversation {
  phone: string;
  phone_display: string;
  data: Record<string, string>;
  messages: WaMessage[];
  last_in: string | null;
  last_at: string;
  can_reply: boolean;
  opted_out: boolean;
}

export interface WaOptout {
  id: number;
  phone: string;
  phone_display: string;
  source: 'reply' | 'button' | 'manual';
  campaign_name?: string | null;
  created_at: string;
}
