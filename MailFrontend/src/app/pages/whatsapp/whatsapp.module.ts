import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';
import { WaListComponent } from './wa-list.component';
import { WaSetupComponent } from './wa-setup.component';
import { WaEditorComponent } from './wa-editor.component';

const routes: Routes = [
  { path: '', component: WaListComponent },
  { path: 'setup', component: WaSetupComponent },
  { path: ':id', component: WaEditorComponent }
];

/** WhatsApp campaigns. Loaded only when someone opens WhatsApp, like Campaigns. */
@NgModule({
  declarations: [WaListComponent, WaSetupComponent, WaEditorComponent],
  imports: [CommonModule, FormsModule, RouterModule.forChild(routes), SharedModule]
})
export class WhatsappModule {}
