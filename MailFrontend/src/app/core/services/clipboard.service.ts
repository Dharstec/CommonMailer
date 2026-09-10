import { Injectable } from '@angular/core';
import { ToastService } from './toast.service';

/**
 * Copying text needs two implementations, not one.
 *
 * `navigator.clipboard` exists only in a secure context — https, or localhost.
 * Open the panel over plain http (a LAN IP while showing it to someone, an S3
 * website endpoint before CloudFront, an IP straight to the server) and the
 * whole `clipboard` object is undefined, so reading `.writeText` off it threw a
 * TypeError inside the click handler: nothing was copied and no error toast
 * appeared either, because the throw happened before the promise existed.
 *
 * `document.execCommand('copy')` is deprecated but works in exactly the places
 * the modern API does not, and every browser still supports it. Try the good
 * one, fall back to the old one, and only then tell the user to copy manually.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardService {
  constructor(private toast: ToastService) {}

  /** Copies `text` and reports the outcome as a toast. */
  async copy(text: string, label = 'Text'): Promise<boolean> {
    if (!text) {
      this.toast.error(`Nothing to copy yet — the ${label.toLowerCase()} is empty.`);
      return false;
    }

    const copied = (await this.viaClipboardApi(text)) || this.viaExecCommand(text);
    if (copied) {
      this.toast.success(`${label} copied.`);
    } else {
      this.toast.error(`Could not copy the ${label.toLowerCase()}. Select the text and copy it manually.`);
    }
    return copied;
  }

  private async viaClipboardApi(text: string): Promise<boolean> {
    // Optional chaining on `clipboard` itself, not just on the method: on http
    // the entire object is missing.
    if (!navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Rejects when the document is not focused (devtools has focus) or the
      // permission is denied. Fall through to the textarea rather than fail.
      return false;
    }
  }

  private viaExecCommand(text: string): boolean {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Off-screen but still selectable — `display:none` or `visibility:hidden`
    // makes the selection, and therefore the copy, a no-op.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);

    const previous = document.activeElement as HTMLElement | null;
    try {
      area.select();
      area.setSelectionRange(0, text.length);   // iOS Safari ignores select() alone
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      document.body.removeChild(area);
      previous?.focus();
    }
  }
}
