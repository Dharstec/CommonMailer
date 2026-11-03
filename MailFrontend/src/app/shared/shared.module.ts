import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConfirmComponent } from './confirm.component';
import { SendWindowComponent } from './send-window.component';

/** Pieces used both by the main app and by lazily loaded modules (Campaigns). */
@NgModule({
  declarations: [ConfirmComponent, SendWindowComponent],
  imports: [CommonModule],
  exports: [ConfirmComponent, SendWindowComponent]
})
export class SharedModule {}
