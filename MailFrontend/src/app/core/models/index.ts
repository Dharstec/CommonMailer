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

export interface DashboardStats {
  active_tenants: number;
  active_forms: number;
  submissions_30d: number;
  failed_30d: number;
  spam_30d: number;
  recent: Submission[];
  daily: { day: string; total: number }[];
}
