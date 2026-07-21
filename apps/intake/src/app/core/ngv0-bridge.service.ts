import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { PreviewSeed } from '@sf/shared';
import { NG_V0_UI_BASE, ORCHESTRATOR_BASE } from './ngv0.config';

/** Outcome of a "Send back to the factory" attempt, already turned into a
 *  plain-language line for the requester (this app never says 'gate' or
 *  'bundle' — PRODUCT.md vocabulary guards). */
export interface SendBackResult {
  ok: boolean;
  message: string;
}

/** Only the fields we read off the orchestrator's GET /chats rows. */
interface OrchestratorChat {
  chatId: string;
  title: string | null;
  seedRef: string | null;
}

/** Orchestrator version row (GET /chats/:id/versions) — we need id + seq. */
interface OrchestratorVersion {
  id: string;
  seq: number;
}

/** POST /chats/:id/versions/:vid/export response. */
interface ExportResult {
  bundle: string;
  seedRef: string;
  versions: { sha: string; message: string }[];
}

/**
 * The intake side of the ng-v0 bridge (docs/design/ng-v0-bridge.md, "UX").
 *
 * Two hops, two origins:
 *  - the ng-v0 UI (NG_V0_UI_BASE) — where "Edit in ng-v0" sends the requester;
 *  - the Hono orchestrator (ORCHESTRATOR_BASE) — where a sandbox chat lives and
 *    a version is exported.
 * The final import-edit POST goes to the factory's own `/api` (relative), so it
 * rides the factory auth interceptor; the cross-origin orchestrator calls do not
 * (the interceptor only attaches tokens to `/api` URLs).
 */
@Injectable({ providedIn: 'root' })
export class NgV0Bridge {
  private http = inject(HttpClient);

  /** The ng-v0 editor URL that seeds a fresh chat from this preview's head. */
  editUrl(rid: string, seed: PreviewSeed): string {
    const q = new URLSearchParams({ seed: rid, url: seed.url, ref: seed.ref });
    return `${NG_V0_UI_BASE}/chats/new?${q.toString()}`;
  }

  /** The newest sandbox chat seeded from this previewed sha, or null. A later
   *  re-seed appends a newer chat, so the last match wins. */
  async findChat(seedRef: string): Promise<OrchestratorChat | null> {
    let chats: OrchestratorChat[];
    try {
      chats = await firstValueFrom(this.http.get<OrchestratorChat[]>(`${ORCHESTRATOR_BASE}/chats`));
    } catch {
      return null;
    }
    const matches = (chats ?? []).filter((c) => c.seedRef === seedRef);
    return matches.length ? matches[matches.length - 1] : null;
  }

  /**
   * Export the sandbox chat's latest version and hand it to the factory to
   * re-check. Returns a ready-to-show plain-language result either way.
   */
  async sendBack(rid: number, seedRef: string): Promise<SendBackResult> {
    const chat = await this.findChat(seedRef);
    if (!chat) {
      return {
        ok: false,
        message: "We couldn't find your edits. Open the editor, make a change, then try again.",
      };
    }

    let versions: OrchestratorVersion[];
    try {
      versions = await firstValueFrom(
        this.http.get<OrchestratorVersion[]>(`${ORCHESTRATOR_BASE}/chats/${chat.chatId}/versions`),
      );
    } catch {
      return { ok: false, message: "We couldn't reach your editor to collect the changes." };
    }
    if (!versions?.length) {
      return {
        ok: false,
        message: 'Your editor has no saved changes yet — make an edit, then send it back.',
      };
    }
    const latest = versions.reduce((a, b) => (b.seq > a.seq ? b : a));

    let exported: ExportResult;
    try {
      exported = await firstValueFrom(
        this.http.post<ExportResult>(
          `${ORCHESTRATOR_BASE}/chats/${chat.chatId}/versions/${latest.id}/export`,
          {},
        ),
      );
    } catch {
      return { ok: false, message: "We couldn't package your changes from the editor." };
    }

    try {
      await firstValueFrom(
        this.http.post(`/api/requests/${rid}/preview/import-edit`, {
          bundle: exported.bundle,
          summary: chat.title || 'sandbox edits',
          versions: exported.versions,
        }),
      );
      return { ok: true, message: 'Sent — the factory is re-checking your edits.' };
    } catch (err) {
      // 409/422 carry a server `detail`; surface it verbatim (it is already
      // requester-facing). Anything else gets a plain fallback.
      const detail =
        err instanceof HttpErrorResponse && typeof err.error?.detail === 'string'
          ? err.error.detail
          : 'The factory could not take these changes right now. Try again from the editor.';
      return { ok: false, message: detail };
    }
  }
}
