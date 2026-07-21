import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NgV0Bridge } from './ngv0-bridge.service';
import { NG_V0_UI_BASE, ORCHESTRATOR_BASE } from './ngv0.config';

/** Drain queued microtasks so each awaited HttpClient call settles before the
 *  next request is expected. */
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('NgV0Bridge', () => {
  let bridge: NgV0Bridge;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [NgV0Bridge, provideHttpClient(), provideHttpClientTesting()],
    });
    bridge = TestBed.inject(NgV0Bridge);
    http = TestBed.inject(HttpTestingController);
  });

  it('builds the editor URL from the rid + seed source', () => {
    const url = bridge.editUrl('REQ-42', { url: 'git://api:9418/req-42', ref: 'deadbeef' });
    expect(url).toBe(
      `${NG_V0_UI_BASE}/chats/new?seed=REQ-42&url=git%3A%2F%2Fapi%3A9418%2Freq-42&ref=deadbeef`,
    );
  });

  it('exports the latest version of the seed-matched chat and imports it (202 -> ok)', async () => {
    const promise = bridge.sendBack(42, 'deadbeef');

    // 1. list chats, filtered to the seed sha (last match wins)
    http.expectOne(`${ORCHESTRATOR_BASE}/chats`).flush([
      { chatId: 'other', title: 'x', seedRef: 'cafef00d' },
      { chatId: 'c1', title: 'My edits', seedRef: 'deadbeef' },
    ]);
    await tick();

    // 2. versions -> pick highest seq (v2), not list order
    http.expectOne(`${ORCHESTRATOR_BASE}/chats/c1/versions`).flush([
      { id: 'vA', seq: 1 },
      { id: 'vB', seq: 2 },
    ]);
    await tick();

    // 3. export that version
    const exp = http.expectOne(`${ORCHESTRATOR_BASE}/chats/c1/versions/vB/export`);
    expect(exp.request.method).toBe('POST');
    exp.flush({
      bundle: 'YmFzZTY0',
      seedRef: 'deadbeef',
      versions: [{ sha: 'aaa', message: 'edit 1' }],
    });
    await tick();

    // 4. import into the factory, with the chat title as the summary
    const imp = http.expectOne('/api/requests/42/preview/import-edit');
    expect(imp.request.body).toEqual({
      bundle: 'YmFzZTY0',
      summary: 'My edits',
      versions: [{ sha: 'aaa', message: 'edit 1' }],
    });
    imp.flush(
      { import_id: 1, request_id: 42, status: 'pending' },
      { status: 202, statusText: 'Accepted' },
    );

    expect(await promise).toEqual({
      ok: true,
      message: 'Sent — the factory is re-checking your edits.',
    });
  });

  it('surfaces no-chat when nothing is seeded from this preview', async () => {
    const promise = bridge.sendBack(42, 'deadbeef');
    http
      .expectOne(`${ORCHESTRATOR_BASE}/chats`)
      .flush([{ chatId: 'x', title: null, seedRef: 'somethingelse' }]);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('find your edits');
  });

  it("passes the factory's rejection detail straight through (409)", async () => {
    const promise = bridge.sendBack(42, 'deadbeef');
    http
      .expectOne(`${ORCHESTRATOR_BASE}/chats`)
      .flush([{ chatId: 'c1', title: null, seedRef: 'deadbeef' }]);
    await tick();
    http.expectOne(`${ORCHESTRATOR_BASE}/chats/c1/versions`).flush([{ id: 'vB', seq: 2 }]);
    await tick();
    http.expectOne(`${ORCHESTRATOR_BASE}/chats/c1/versions/vB/export`).flush({
      bundle: 'YmFzZTY0',
      seedRef: 'deadbeef',
      versions: [{ sha: 'aaa', message: 'edit' }],
    });
    await tick();
    // no title -> default summary
    const imp = http.expectOne('/api/requests/42/preview/import-edit');
    expect(imp.request.body.summary).toBe('sandbox edits');
    imp.flush(
      { detail: 'Your app moved on — re-open the editor and redo the change.' },
      { status: 409, statusText: 'Conflict' },
    );

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Your app moved on — re-open the editor and redo the change.');
  });

  afterEach(() => http.verify());
});
