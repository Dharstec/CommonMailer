import { CampaignStatus, WaQuality, WaRecipientStatus, WaTemplateComponent } from '../../core/models';

export const WA_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled'
};

export function waStatusClass(status: CampaignStatus | undefined): string {
  switch (status) {
    case 'sending': return 'badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    case 'scheduled': return 'badge bg-sky-50 text-sky-700 ring-1 ring-sky-200';
    case 'paused': return 'badge-warn';
    case 'completed': return 'badge-ok';
    default: return 'badge-mute';
  }
}

export const WA_RECIPIENT_LABELS: Record<WaRecipientStatus, string> = {
  pending: 'Waiting', sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', skipped: 'Skipped'
};

export function waRecipientClass(status: WaRecipientStatus): string {
  switch (status) {
    case 'read': return 'badge bg-sky-50 text-sky-700 ring-1 ring-sky-200';
    case 'delivered': case 'sent': return 'badge-ok';
    case 'failed': return 'badge-err';
    case 'sending': return 'badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    default: return 'badge-mute';
  }
}

/** Meta's quality rating in words: it is what decides whether a number gets limited. */
export function qualityOf(rating: WaQuality): { label: string; css: string; dot: string } {
  switch (rating) {
    case 'GREEN': return { label: 'High', css: 'badge-ok', dot: 'bg-emerald-500' };
    case 'YELLOW': return { label: 'Medium', css: 'badge-warn', dot: 'bg-amber-500' };
    case 'RED': return { label: 'Low', css: 'badge-err', dot: 'bg-red-500' };
    default: return { label: 'Not rated yet', css: 'badge-mute', dot: 'bg-slate-400' };
  }
}

/** Meta's own cap on new conversations a day — ours is stricter. */
export function limitOf(tier: string | null | undefined): string {
  const names: Record<string, string> = {
    TIER_50: '50', TIER_250: '250', TIER_1K: '1,000', TIER_2K: '2,000', TIER_10K: '10,000', TIER_100K: '100,000', TIER_UNLIMITED: 'Unlimited'
  };
  return tier && names[tier] ? names[tier] : '—';
}

const MERGE_TAG = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|([^{}]*?))?\s*\}\}/g;

/** {{key}} or {{key|fallback}}, keys case-insensitive — the server's rule (helpers/campaignRender.js). */
export function merge(template: string, data: Record<string, string>): string {
  const lower: Record<string, string> = {};
  Object.entries(data || {}).forEach(([k, v]) => { lower[k.toLowerCase()] = String(v ?? ''); });
  return String(template || '').replace(MERGE_TAG, (_m, key: string, fallback?: string) => {
    const value = (lower[key.toLowerCase()] || '').trim();
    return value || (fallback || '').trim();
  });
}

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function variablesIn(text: string | undefined): string[] {
  const names: string[] = [];
  for (const m of String(text || '').matchAll(VARIABLE)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

export interface WaSlots {
  headerFormat: string | null;
  header: string[];
  body: string[];
  buttons: { index: number; text: string; names: string[] }[];
}

/** The fill-in slots of a template, as the server reads them (helpers/whatsapp.js slotsOf). */
export function slotsOf(components: WaTemplateComponent[] | null | undefined): WaSlots {
  const list = components || [];
  const header = list.find((c) => c.type === 'HEADER');
  const body = list.find((c) => c.type === 'BODY');
  const buttons = list.find((c) => c.type === 'BUTTONS')?.buttons || [];
  return {
    headerFormat: header?.format || null,
    header: header?.format === 'TEXT' ? variablesIn(header.text) : [],
    body: variablesIn(body?.text),
    buttons: buttons
      .map((b, index) => ({ index, text: b.text, names: b.type === 'URL' ? variablesIn(b.url) : [] }))
      .filter((b) => b.names.length)
  };
}

/** Puts the values into a template's text; a slot without one shows as [1] so it stands out. */
export function fill(text: string | undefined, values: Record<string, string>): string {
  return String(text || '').replace(VARIABLE, (_m, name: string) => values[name] || `[${name}]`);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** WhatsApp's own formatting — *bold*, _italic_, ~strike~, ```mono``` — as safe HTML for the preview. */
export function waFormat(text: string): string {
  return escapeHtml(text)
    .replace(/```([^`]+)```/g, '<code class="font-mono text-[12px]">$1</code>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<strong>$2</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1<s>$2</s>')
    .replace(/\n/g, '<br>');
}

/** A ready-made template for a first campaign: short, a clear question, and an easy way out. */
export function sampleTemplate(company: string): { body: string; examples: Record<string, string>; footer: string } {
  return {
    body: 'Hello {{1}},\n\nYour CNC machines are talking — *we help you listen.*\n\n'
      + '✅ Live machine status and utilisation\n✅ Why machines stop, and what it costs\n'
      + '✅ Energy, quality and machine health\n✅ Instant alerts on your phone\n\n'
      + 'Would you like a quick 20-minute demo for {{2}}?',
    examples: { 1: 'Ramesh', 2: 'Linit Exports' },
    footer: `${company || 'Your company'} · Reply STOP to opt out`.slice(0, 60)
  };
}

export const WA_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'bn', label: 'Bengali' },
  { code: 'pa', label: 'Punjabi' }
];
