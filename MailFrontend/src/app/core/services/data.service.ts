import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import {
  ApiResponse, Campaign, CampaignAttachment, CampaignPreview, CampaignRecipient, CampaignUnsubscribe,
  ContactForm, DashboardStats, EmailTemplate, ImportSummary, Submission, Tenant, TenantSmtp
} from '../models';

/** Customers and their sending accounts. */
@Injectable({ providedIn: 'root' })
export class TenantService {
  constructor(private api: ApiService) {}

  list(): Observable<Tenant[]> { return this.api.get<Tenant[]>('tenants'); }
  get(id: number): Observable<Tenant> { return this.api.get<Tenant>(`tenants/${id}`); }
  create(body: Tenant): Observable<ApiResponse<Tenant>> { return this.api.post('tenants', body); }
  update(id: number, body: Tenant): Observable<ApiResponse<Tenant>> { return this.api.put(`tenants/${id}`, body); }
  remove(id: number): Observable<ApiResponse<null>> { return this.api.delete(`tenants/${id}`); }

  saveSmtp(id: number, body: TenantSmtp): Observable<ApiResponse<TenantSmtp>> {
    return this.api.put(`tenants/${id}/smtp`, body);
  }
  testSmtp(id: number): Observable<ApiResponse<null>> { return this.api.post(`tenants/${id}/smtp/test`, {}); }
  sendTest(id: number, to: string): Observable<ApiResponse<null>> {
    return this.api.post(`tenants/${id}/smtp/send-test`, { to });
  }
}

/** Forms, their fields and their mail templates. */
@Injectable({ providedIn: 'root' })
export class FormService {
  constructor(private api: ApiService) {}

  list(tenantId?: number): Observable<ContactForm[]> {
    return this.api.get<ContactForm[]>('forms', { tenant_id: tenantId });
  }
  get(id: number): Observable<ContactForm> { return this.api.get<ContactForm>(`forms/${id}`); }
  create(body: ContactForm): Observable<ApiResponse<ContactForm>> { return this.api.post('forms', body); }
  update(id: number, body: ContactForm): Observable<ApiResponse<ContactForm>> { return this.api.put(`forms/${id}`, body); }
  remove(id: number): Observable<ApiResponse<null>> { return this.api.delete(`forms/${id}`); }

  duplicate(id: number, body: { tenant_id: number; form_key: string; name: string }): Observable<ApiResponse<ContactForm>> {
    return this.api.post(`forms/${id}/duplicate`, body);
  }

  templates(formId: number): Observable<ApiResponse<EmailTemplate[]>> {
    return this.api.getFull<EmailTemplate[]>(`forms/${formId}/templates`);
  }
  saveTemplate(formId: number, body: EmailTemplate): Observable<ApiResponse<EmailTemplate>> {
    return this.api.put(`forms/${formId}/templates`, body);
  }
  previewTemplate(formId: number, body: Partial<EmailTemplate>): Observable<ApiResponse<{ subject: string; html: string; text: string }>> {
    return this.api.post(`forms/${formId}/templates/preview`, body);
  }
  sendTestTemplate(formId: number, to: string, template_type: string): Observable<ApiResponse<null>> {
    return this.api.post(`forms/${formId}/templates/send-test`, { to, template_type });
  }
}

/** The submission log. */
@Injectable({ providedIn: 'root' })
export class SubmissionService {
  constructor(private api: ApiService) {}

  list(query: Record<string, any>): Observable<ApiResponse<Submission[]>> {
    return this.api.getFull<Submission[]>('submissions', query);
  }
  get(id: number): Observable<Submission> { return this.api.get<Submission>(`submissions/${id}`); }
  stats(): Observable<DashboardStats> { return this.api.get<DashboardStats>('submissions/stats'); }
  resend(id: number): Observable<ApiResponse<null>> { return this.api.post(`submissions/${id}/resend`, {}); }
  remove(id: number): Observable<ApiResponse<null>> { return this.api.delete(`submissions/${id}`); }
  exportCsv(query: Record<string, any>) { return this.api.download('submissions/export', query); }
}

/** Campaigns: one message, a recipient list, and the sending that follows. */
@Injectable({ providedIn: 'root' })
export class CampaignService {
  constructor(private api: ApiService) {}

  list(query: Record<string, any> = {}): Observable<Campaign[]> { return this.api.get<Campaign[]>('campaigns', query); }
  get(id: number): Observable<Campaign> { return this.api.get<Campaign>(`campaigns/${id}`); }
  create(body: Campaign): Observable<ApiResponse<Campaign>> { return this.api.post('campaigns', body); }
  update(id: number, body: Campaign): Observable<ApiResponse<Campaign>> { return this.api.put(`campaigns/${id}`, body); }
  remove(id: number): Observable<ApiResponse<null>> { return this.api.delete(`campaigns/${id}`); }
  duplicate(id: number): Observable<ApiResponse<Campaign>> { return this.api.post(`campaigns/${id}/duplicate`, {}); }

  recipients(id: number, query: Record<string, any>): Observable<ApiResponse<CampaignRecipient[]>> {
    return this.api.getFull<CampaignRecipient[]>(`campaigns/${id}/recipients`, query);
  }
  uploadRecipients(id: number, file: Blob, filename: string): Observable<ApiResponse<ImportSummary>> {
    return this.api.upload(`campaigns/${id}/recipients`, file, { filename });
  }
  clearRecipients(id: number): Observable<ApiResponse<null>> { return this.api.delete(`campaigns/${id}/recipients`); }
  exportRecipients(id: number): Observable<Blob> { return this.api.download(`campaigns/${id}/recipients/export`); }

  uploadAttachment(id: number, file: File): Observable<ApiResponse<CampaignAttachment>> {
    return this.api.upload(`campaigns/${id}/attachments`, file, { filename: file.name, type: file.type });
  }
  removeAttachment(id: number, attachmentId: number): Observable<ApiResponse<null>> {
    return this.api.delete(`campaigns/${id}/attachments/${attachmentId}`);
  }

  /** Both take the editor's unsaved state, so what you preview is what you test. */
  preview(id: number, body: Campaign & { recipient_id?: number | null }): Observable<ApiResponse<CampaignPreview>> {
    return this.api.post(`campaigns/${id}/preview`, body);
  }
  sendTest(id: number, body: Campaign & { to: string; recipient_id?: number | null }): Observable<ApiResponse<null>> {
    return this.api.post(`campaigns/${id}/test`, body);
  }

  start(id: number, scheduledAt: string | null = null): Observable<ApiResponse<null>> {
    return this.api.post(`campaigns/${id}/start`, { scheduled_at: scheduledAt });
  }
  pause(id: number): Observable<ApiResponse<null>> { return this.api.post(`campaigns/${id}/pause`, {}); }
  cancel(id: number): Observable<ApiResponse<null>> { return this.api.post(`campaigns/${id}/cancel`, {}); }
  retryFailed(id: number): Observable<ApiResponse<null>> { return this.api.post(`campaigns/${id}/retry-failed`, {}); }

  unsubscribes(tenantId: number): Observable<CampaignUnsubscribe[]> {
    return this.api.get<CampaignUnsubscribe[]>('campaigns/unsubscribes', { tenant_id: tenantId });
  }
  addUnsubscribes(tenantId: number, emails: string): Observable<ApiResponse<null>> {
    return this.api.post('campaigns/unsubscribes', { tenant_id: tenantId, emails });
  }
  removeUnsubscribe(id: number): Observable<ApiResponse<null>> { return this.api.delete(`campaigns/unsubscribes/${id}`); }
}
