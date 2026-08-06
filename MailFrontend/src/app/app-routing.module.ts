import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AuthGuard, GuestGuard } from './core/guards/auth.guard';
import { ShellComponent } from './layout/shell.component';
import { LoginComponent } from './pages/login/login.component';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { TenantListComponent } from './pages/tenants/tenant-list.component';
import { TenantDetailComponent } from './pages/tenants/tenant-detail.component';
import { FormListComponent } from './pages/forms/form-list.component';
import { FormBuilderComponent } from './pages/forms/form-builder.component';
import { SubmissionListComponent } from './pages/submissions/submission-list.component';
import { SubmissionDetailComponent } from './pages/submissions/submission-detail.component';
import { ChangePasswordComponent } from './pages/change-password.component';

const routes: Routes = [
  { path: 'login', component: LoginComponent, canActivate: [GuestGuard] },
  {
    path: '',
    component: ShellComponent,
    canActivate: [AuthGuard],
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      { path: 'dashboard', component: DashboardComponent },
      { path: 'customers', component: TenantListComponent },
      { path: 'customers/:id', component: TenantDetailComponent },
      { path: 'forms', component: FormListComponent },
      { path: 'forms/:id', component: FormBuilderComponent },
      { path: 'submissions', component: SubmissionListComponent },
      { path: 'submissions/:id', component: SubmissionDetailComponent },
      { path: 'change-password', component: ChangePasswordComponent }
    ]
  },
  { path: '**', redirectTo: '' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}
