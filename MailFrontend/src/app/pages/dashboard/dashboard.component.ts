import { Component, OnInit } from '@angular/core';
import { SubmissionService } from '../../core/services/data.service';
import { DashboardStats } from '../../core/models';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html'
})
export class DashboardComponent implements OnInit {
  stats: DashboardStats | null = null;
  loading = true;

  constructor(private submissions: SubmissionService) {}

  ngOnInit(): void {
    this.submissions.stats().subscribe({
      next: (data) => { this.stats = data; this.loading = false; },
      error: () => { this.loading = false; }
    });
  }

  /** Bar height as a percentage of the busiest day in the window. */
  barHeight(total: number): string {
    const peak = Math.max(1, ...(this.stats?.daily || []).map((d) => d.total));
    return `${Math.max(4, (total / peak) * 100)}%`;
  }

  statusClass(status: string): string {
    if (status === 'sent') return 'badge-ok';
    if (status === 'failed') return 'badge-err';
    if (status === 'spam') return 'badge-mute';
    return 'badge-warn';
  }
}
