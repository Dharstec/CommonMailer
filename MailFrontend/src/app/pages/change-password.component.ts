import { Component } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';

@Component({
  selector: 'app-change-password',
  template: `
    <div class="max-w-md mx-auto">
      <h1 class="text-2xl font-bold text-slate-900 mb-5">Change password</h1>
      <form class="card card-body space-y-4" [formGroup]="form" (ngSubmit)="submit()">
        <div>
          <label class="label">Current password</label>
          <input class="input" type="password" formControlName="current_password" autocomplete="current-password"/>
        </div>
        <div>
          <label class="label">New password</label>
          <input class="input" type="password" formControlName="new_password" autocomplete="new-password"/>
          <p class="hint">At least 8 characters.</p>
          <p class="err" *ngIf="form.controls.new_password.touched && form.controls.new_password.invalid">
            New password must be at least 8 characters.
          </p>
        </div>
        <div>
          <label class="label">Confirm new password</label>
          <input class="input" type="password" formControlName="confirm" autocomplete="new-password"/>
          <p class="err" *ngIf="form.value.confirm && form.value.confirm !== form.value.new_password">
            Passwords do not match.
          </p>
        </div>
        <div class="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-xs text-slate-600">
          Changing your password signs you out of every device, including this one.
        </div>
        <button type="submit" class="btn-primary w-full" [disabled]="loading">
          {{ loading ? 'Saving...' : 'Change password' }}
        </button>
      </form>
    </div>
  `
})
export class ChangePasswordComponent {
  loading = false;

  readonly form = this.fb.group({
    current_password: ['', Validators.required],
    new_password: ['', [Validators.required, Validators.minLength(8)]],
    confirm: ['', Validators.required]
  });

  constructor(private fb: FormBuilder, private auth: AuthService, private toast: ToastService) {}

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (this.form.value.new_password !== this.form.value.confirm) {
      this.toast.error('The new passwords do not match.');
      return;
    }

    this.loading = true;
    this.auth.changePassword(this.form.value.current_password!, this.form.value.new_password!).subscribe({
      next: () => {
        this.toast.success('Password changed. Please log in again.');
        this.auth.clearSession();
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.message || 'Could not change the password.');
      }
    });
  }
}
