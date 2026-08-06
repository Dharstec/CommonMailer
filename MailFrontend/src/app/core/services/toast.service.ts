import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private counter = 0;
  private subject = new BehaviorSubject<Toast[]>([]);
  readonly toasts$ = this.subject.asObservable();

  private push(kind: Toast['kind'], message: string, ms: number): void {
    const toast: Toast = { id: ++this.counter, kind, message };
    this.subject.next([...this.subject.value, toast]);
    // ms === 0 means "stay until dismissed".
    if (ms > 0) setTimeout(() => this.dismiss(toast.id), ms);
  }

  success(message: string): void { this.push('success', message, 3500); }
  info(message: string): void { this.push('info', message, 3500); }

  /**
   * Errors stay until dismissed. Several of them — the SMTP guidance in
   * particular — are multi-line instructions the user has to follow, and a
   * timer that hides them mid-read is worse than useless.
   */
  error(message: string): void { this.push('error', message, 0); }

  dismiss(id: number): void {
    this.subject.next(this.subject.value.filter((t) => t.id !== id));
  }
}
