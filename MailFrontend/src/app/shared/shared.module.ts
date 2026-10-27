import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConfirmComponent } from './confirm.component';

/** Pieces used both by the main app and by lazily loaded modules (Campaigns). */
@NgModule({
  declarations: [ConfirmComponent],
  imports: [CommonModule],
  exports: [ConfirmComponent]
})
export class SharedModule {}
