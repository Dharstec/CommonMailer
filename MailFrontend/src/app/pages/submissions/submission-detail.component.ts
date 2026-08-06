import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SubmissionService } from '../../core/services/data.service';
import { ToastService } from '../../core/services/toast.service';
import { Submission } from '../../core/models';

@Component({
  selector: 'app-submission-detail',
  templateUrl: './submission-detail.component.html'
})
export class SubmissionDetailComponent implements OnInit {
  submission: Submission | null = null;
  loading = true;
  confirmOpen = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private service: SubmissionService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.service.get(id).subscribe({
      next: (data) => { this.submission = data; this.loading = false; },
      error: () => { this.loading = false; }
    });
  }

  /**
   * Ordered by the form's own field order, with any key that no longer matches a
   * field appended — a submission from before a field was renamed still shows
   * its data rather than silently hiding it.
   */
  get rows(): { label: string; value: string }[] {
    if (!this.submission) return [];
    const data = this.submission.data || {};
    const fields = this.submission.fields || [];

    const known = fields
      .filter((f) => data[f.field_key] !== undefined)
      .map((f) => ({ label: f.label, value: this.display(data[f.field_key]) }));

    const knownKeys = new Set(fields.map((f) => f.field_key));
    const extras = Object.keys(data)
      .filter((k) => !knownKeys.has(k))
      .map((k) => ({ label: k, value: this.display(data[k]) }));

    return [...known, ...extras];
  }

  private display(value: any): string {
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return value === null || value === undefined ? '' : String(value);
  }

  statusClass(status: string): string {
    if (status === 'sent') return 'badge-ok';
    if (status === 'failed') return 'badge-err';
    if (status === 'spam') return 'badge-mute';
    return 'badge-warn';
  }

  resend(): void {
    if (!this.submission) return;
    this.service.resend(this.submission.id).subscribe({
      next: () => {
        this.toast.success('Notification resent.');
        this.submission!.mail_status = 'sent';
        this.submission!.mail_error = null;
      },
      error: (err) => this.toast.error(err.error?.message || 'Could not resend.')
    });
  }

  remove(): void {
    if (!this.submission) return;
    this.service.remove(this.submission.id).subscribe({
      next: () => {
        this.toast.success('Submission deleted.');
        this.router.navigate(['/submissions']);
      }
    });
  }
}
