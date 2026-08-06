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
    setTimeout(() => this.dismiss(toast.id), ms);
  }

  // Errors linger: they usually carry something the user has to read and act on.
  success(message: string): void { this.push('success', message, 3500); }
  error(message: string): void { this.push('error', message, 7000); }
  info(message: string): void { this.push('info', message, 3500); }

  dismiss(id: number): void {
    this.subject.next(this.subject.value.filter((t) => t.id !== id));
  }
}
