import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HTTP_INTERCEPTORS, HttpClientModule } from '@angular/common/http';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { AuthInterceptor } from './core/interceptors/auth.interceptor';

import { ShellComponent } from './layout/shell.component';
import { ToastComponent } from './shared/toast.component';
import { ConfirmComponent } from './shared/confirm.component';

import { LoginComponent } from './pages/login/login.component';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { TenantListComponent } from './pages/tenants/tenant-list.component';
import { TenantDetailComponent } from './pages/tenants/tenant-detail.component';
import { FormListComponent } from './pages/forms/form-list.component';
import { FormBuilderComponent } from './pages/forms/form-builder.component';
import { SubmissionListComponent } from './pages/submissions/submission-list.component';
import { SubmissionDetailComponent } from './pages/submissions/submission-detail.component';
import { ChangePasswordComponent } from './pages/change-password.component';

@NgModule({
  declarations: [
    AppComponent,
    ShellComponent,
    ToastComponent,
    ConfirmComponent,
    LoginComponent,
    DashboardComponent,
    TenantListComponent,
    TenantDetailComponent,
    FormListComponent,
    FormBuilderComponent,
    SubmissionListComponent,
    SubmissionDetailComponent,
    ChangePasswordComponent
  ],
  imports: [
    BrowserModule,
    HttpClientModule,
    FormsModule,
    ReactiveFormsModule,
    AppRoutingModule
  ],
  providers: [
    { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true }
  ],
  bootstrap: [AppComponent]
})
export class AppModule {}
