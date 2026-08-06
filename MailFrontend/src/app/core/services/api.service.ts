import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from 'src/environments/environment';
import { ApiResponse } from '../models';

/**
 * Thin wrapper over HttpClient that unwraps the `{ status, data }` envelope
 * every endpoint returns, so components deal in domain objects only.
 * Errors are handled centrally by the interceptor.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private http: HttpClient) {}

  private url(path: string): string {
    return `${environment.apiUrl}/${path.replace(/^\//, '')}`;
  }

  private toParams(query?: Record<string, any>): HttpParams {
    let params = new HttpParams();
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        params = params.set(key, String(value));
      }
    });
    return params;
  }

  get<T>(path: string, query?: Record<string, any>): Observable<T> {
    return this.http.get<ApiResponse<T>>(this.url(path), { params: this.toParams(query) })
      .pipe(map((res) => res.data));
  }

  /** For endpoints where pagination or defaults are needed alongside data. */
  getFull<T>(path: string, query?: Record<string, any>): Observable<ApiResponse<T>> {
    return this.http.get<ApiResponse<T>>(this.url(path), { params: this.toParams(query) });
  }

  post<T>(path: string, body: any): Observable<ApiResponse<T>> {
    return this.http.post<ApiResponse<T>>(this.url(path), body);
  }

  put<T>(path: string, body: any): Observable<ApiResponse<T>> {
    return this.http.put<ApiResponse<T>>(this.url(path), body);
  }

  delete<T>(path: string): Observable<ApiResponse<T>> {
    return this.http.delete<ApiResponse<T>>(this.url(path));
  }

  /** CSV export needs the raw blob rather than the JSON envelope. */
  download(path: string, query?: Record<string, any>): Observable<Blob> {
    return this.http.get(this.url(path), { params: this.toParams(query), responseType: 'blob' });
  }
}
