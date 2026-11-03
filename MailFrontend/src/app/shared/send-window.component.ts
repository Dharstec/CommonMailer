import { Component, EventEmitter, Input, Output } from '@angular/core';
import { SendWindow } from '../core/models';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Old names some browsers still report for a zone; the same clock either way. */
const ZONE_NAMES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon'
};

/** Working hours in the browser's own time zone: 10:00–18:00, Monday to Saturday. */
export function defaultWindow(): SendWindow {
  let tz = 'Asia/Kolkata';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* old browser */ }
  return { start: '10:00', end: '18:00', days: [1, 2, 3, 4, 5, 6], tz: ZONE_NAMES[tz] || tz };
}

/** "10:00–18:00, Mon–Sat" — the server's wording (helpers/sendWindow.js). */
export function describeWindow(w: SendWindow | null | undefined): string {
  if (!w) return 'any time';
  const days = [...new Set(w.days)].sort();
  const run = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const which = days.length === 7 ? 'every day' : run ? `${DAY_NAMES[days[0]]}–${DAY_NAMES[days[days.length - 1]]}` : days.map((d) => DAY_NAMES[d]).join(', ');
  return `${w.start}–${w.end}, ${which}`;
}

/**
 * Sending hours for a campaign, email or WhatsApp. Outside them the queue just
 * waits for the next opening — so a list started at 9 PM goes on at 10 AM.
 */
@Component({
  selector: 'app-send-window',
  template: `
    <div class="space-y-3">
      <label class="flex items-start gap-2.5 text-sm text-slate-700">
        <input type="checkbox" class="mt-0.5 rounded border-slate-300" [checked]="!!value" [disabled]="disabled"
               (change)="$event.stopPropagation(); toggle($any($event.target).checked)"/>
        <span>
          <span class="font-medium">Only send during working hours</span>
          <span class="block text-xs text-slate-500 mt-0.5">Outside them the queue waits — nothing is skipped. Messages read at work get answered.</span>
        </span>
      </label>
      <div *ngIf="value" class="pl-7 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <input type="time" class="input !w-32" [value]="value.start" [disabled]="disabled"
                 (change)="$event.stopPropagation(); set('start', $any($event.target).value)"/>
          <span class="text-sm text-slate-500">to</span>
          <input type="time" class="input !w-32" [value]="value.end" [disabled]="disabled"
                 (change)="$event.stopPropagation(); set('end', $any($event.target).value)"/>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button *ngFor="let d of week" type="button" class="btn-ghost btn-sm !px-2.5" [disabled]="disabled"
                  [ngClass]="value.days.includes(d) ? '!bg-slate-900 !text-white !border-slate-900' : ''" (click)="toggleDay(d)">{{ names[d] }}</button>
        </div>
        <p *ngIf="value.start >= value.end" class="text-xs text-red-600">The hours must end later in the day than they start.</p>
        <p class="hint">{{ value.tz }} time.</p>
      </div>
    </div>
  `
})
export class SendWindowComponent {
  @Input() value: SendWindow | null | undefined = null;
  @Input() disabled = false;
  @Output() valueChange = new EventEmitter<SendWindow | null>();

  readonly week = [1, 2, 3, 4, 5, 6, 0];
  readonly names = DAY_NAMES;

  toggle(on: boolean): void {
    this.emit(on ? (this.value || defaultWindow()) : null);
  }

  set(key: 'start' | 'end', time: string): void {
    if (this.value && /^\d{2}:\d{2}$/.test(time)) this.emit({ ...this.value, [key]: time });
  }

  toggleDay(day: number): void {
    if (!this.value) return;
    const days = this.value.days.includes(day) ? this.value.days.filter((d) => d !== day) : [...this.value.days, day];
    if (days.length) this.emit({ ...this.value, days: days.sort() });
  }

  private emit(value: SendWindow | null): void {
    this.value = value;
    this.valueChange.emit(value);
  }
}
