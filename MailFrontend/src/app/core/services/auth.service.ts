import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { environment } from 'src/environments/environment';
import { AdminUser, ApiResponse } from '../models';

const TOKEN_KEY = 'cm_token';
const USER_KEY = 'cm_user';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private userSubject = new BehaviorSubject<AdminUser | null>(this.readUser());
  readonly user$ = this.userSubject.asObservable();

  constructor(private http: HttpClient, private router: Router) {}

  private readUser(): AdminUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  get currentUser(): AdminUser | null {
    return this.userSubject.value;
  }

  get isLoggedIn(): boolean {
    return Boolean(this.token);
  }

  login(email: string, password: string): Observable<ApiResponse<{ token: string; user: AdminUser }>> {
    return this.http
      .post<ApiResponse<{ token: string; user: AdminUser }>>(`${environment.apiUrl}/auth/login`, { email, password })
      .pipe(tap((res) => {
        if (res.status === 'success') {
          localStorage.setItem(TOKEN_KEY, res.data.token);
          localStorage.setItem(USER_KEY, JSON.stringify(res.data.user));
          this.userSubject.next(res.data.user);
        }
      }));
  }

  /**
   * Tells the server to drop this token before clearing local state. If that
   * call fails we still clear locally — the user asked to be logged out, and a
   * network error must not leave them stuck in a signed-in UI.
   */
  logout(): void {
    this.http.post(`${environment.apiUrl}/auth/logout`, {})
      .pipe(catchError(() => of(null)))
      .subscribe(() => this.clearSession());
  }

  clearSession(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this.userSubject.next(null);
    this.router.navigate(['/login']);
  }

  changePassword(current_password: string, new_password: string): Observable<ApiResponse<null>> {
    return this.http.post<ApiResponse<null>>(`${environment.apiUrl}/auth/change-password`, {
      current_password, new_password
    });
  }
}
