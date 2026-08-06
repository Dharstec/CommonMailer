import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';

/**
 * Attaches the bearer token and turns API errors into a single toast, so no
 * component has to write its own error handling for the common cases.
 *
 * 400 responses are passed through untouched: those carry per-field validation
 * errors that the form components render inline, and a toast on top would be
 * noise.
 */
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private auth: AuthService, private toast: ToastService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    const token = this.auth.token;
    const authorised = token
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;

    return next.handle(authorised).pipe(
      catchError((error: HttpErrorResponse) => {
        const message = error.error?.message || error.message || 'Something went wrong.';

        if (error.status === 401 || error.status === 403) {
          // A rejected token means the session is gone server-side; sending the
          // user back to login is the only useful action.
          if (this.auth.isLoggedIn && !req.url.includes('/auth/login')) {
            this.toast.error('Your session has ended. Please log in again.');
            this.auth.clearSession();
            return throwError(() => error);
          }
        } else if (error.status === 0) {
          this.toast.error('Cannot reach the server. Is the backend running?');
        } else if (error.status !== 400) {
          this.toast.error(message);
        }

        return throwError(() => error);
      })
    );
  }
}
