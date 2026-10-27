import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';
import { CampaignListComponent } from './campaign-list.component';
import { CampaignEditorComponent } from './campaign-editor.component';

const routes: Routes = [
  { path: '', component: CampaignListComponent },
  { path: ':id', component: CampaignEditorComponent }
];

/**
 * Loaded only when someone opens Campaigns. It is the largest screen in the
 * panel and most sessions never visit it, so it stays out of the first download.
 */
@NgModule({
  declarations: [CampaignListComponent, CampaignEditorComponent],
  imports: [CommonModule, FormsModule, RouterModule.forChild(routes), SharedModule]
})
export class CampaignsModule {}
