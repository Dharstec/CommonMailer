import { Component } from '@angular/core';
import { ToastService } from '../core/services/toast.service';

@Component({
  selector: 'app-toast',
  template: `
    <div class="fixed top-4 right-4 z-50 flex flex-col gap-2 w-[22rem] max-w-[calc(100vw-2rem)]">
      <div *ngFor="let t of toast.toasts$ | async"
           class="rounded-lg px-4 py-3 text-sm shadow-lg border flex items-start gap-3"
           [ngClass]="{
             'bg-emerald-50 border-emerald-200 text-emerald-800': t.kind === 'success',
             'bg-red-50 border-red-200 text-red-800': t.kind === 'error',
             'bg-slate-800 border-slate-700 text-white': t.kind === 'info'
           }">
        <span class="flex-1 leading-snug">{{ t.message }}</span>
        <button type="button" class="opacity-60 hover:opacity-100 leading-none text-lg"
                (click)="toast.dismiss(t.id)">&times;</button>
      </div>
    </div>
  `
})
export class ToastComponent {
  constructor(public toast: ToastService) {}
}
