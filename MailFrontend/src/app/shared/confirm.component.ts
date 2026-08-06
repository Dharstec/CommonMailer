import { Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * Deletes here cascade (a customer takes their forms and submissions with them),
 * so destructive actions always route through this rather than a bare click.
 */
@Component({
  selector: 'app-confirm',
  template: `
    <div *ngIf="open" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50"
         (click)="cancelled.emit()">
      <div class="card w-full max-w-md" (click)="$event.stopPropagation()">
        <div class="card-body">
          <h3 class="text-lg font-semibold text-slate-900">{{ title }}</h3>
          <p class="mt-2 text-sm text-slate-600 whitespace-pre-line">{{ message }}</p>
          <div class="mt-6 flex justify-end gap-2">
            <button type="button" class="btn-ghost" (click)="cancelled.emit()">Cancel</button>
            <button type="button" class="btn-danger" (click)="confirmed.emit()">{{ confirmLabel }}</button>
          </div>
        </div>
      </div>
    </div>
  `
})
export class ConfirmComponent {
  @Input() open = false;
  @Input() title = 'Are you sure?';
  @Input() message = 'This action cannot be undone.';
  @Input() confirmLabel = 'Delete';
  @Output() confirmed = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();
}
