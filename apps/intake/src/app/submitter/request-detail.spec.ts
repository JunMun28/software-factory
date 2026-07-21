import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Api, Poll, PreviewStatus, RequestDetail } from '@sf/shared';
import { NgV0Bridge, SendBackResult } from '../core/ngv0-bridge.service';
import { Session } from '../core/session.service';
import { SubRequestDetail } from './request-detail';

// SubShell injects Theme, which reads matchMedia on construction.
beforeAll(() => {
  globalThis.matchMedia ??= (() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof globalThis.matchMedia;
});

/** A request parked at the preview-accept gate — only the fields the card reads. */
function detail(over: Partial<RequestDetail> = {}): RequestDetail {
  return {
    id: 42,
    ref: 'REQ-42',
    title: 'Sticky filters',
    description: '',
    type: 'new',
    app_name: 'Shipping Console',
    status: 'approved',
    stage: 'preview',
    gate: 'accept_preview',
    reach: null,
    impact_metric: null,
    impact_value: null,
    send_back_question: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    run: null,
    ...over,
  } as RequestDetail;
}

function preview(over: Partial<PreviewStatus> = {}): PreviewStatus {
  return {
    round: 1,
    url: null,
    gate: 'accept_preview',
    sha: 'deadbeef',
    digest: null,
    state: 'ready',
    feedback: [],
    editable: false,
    seed: null,
    ...over,
  };
}

interface BridgeMock {
  editUrl: ReturnType<typeof vi.fn>;
  findChat: ReturnType<typeof vi.fn>;
  sendBack: ReturnType<typeof vi.fn>;
}

async function setup(opts: {
  prev?: PreviewStatus;
  hasChat?: boolean;
  sendResult?: SendBackResult;
}) {
  const bridge: BridgeMock = {
    editUrl: vi.fn(() => 'http://localhost:4200/chats/new?seed=REQ-42'),
    findChat: vi.fn(() => Promise.resolve(opts.hasChat ? { chatId: 'c1' } : null)),
    sendBack: vi.fn(() =>
      Promise.resolve(
        opts.sendResult ?? { ok: true, message: 'Sent — the factory is re-checking your edits.' },
      ),
    ),
  };
  const api = {
    request: vi.fn(() => of(detail())),
    previewStatus: vi.fn(() => of(opts.prev ?? preview())),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SubRequestDetail],
    providers: [
      provideRouter([]),
      { provide: Api, useValue: api },
      { provide: NgV0Bridge, useValue: bridge },
      { provide: Poll, useValue: { start: vi.fn(), nudge: vi.fn(), version: () => 0 } },
      { provide: Session, useValue: { user: () => ({ name: 'Jordan D.', initials: 'JD' }) } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '42' } } } },
    ],
  });
  const fixture = TestBed.createComponent(SubRequestDetail);
  fixture.detectChanges();
  // let the async findChat probe resolve, then re-render
  await Promise.resolve();
  await Promise.resolve();
  fixture.detectChanges();
  return { fixture, bridge, root: fixture.nativeElement as HTMLElement };
}

function byText(root: HTMLElement, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) =>
    el.textContent?.includes(text),
  );
}

describe('SubRequestDetail — ng-v0 bridge preview card', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('honest-disables "Edit in ng-v0" when the preview is not editable', async () => {
    const { root, bridge } = await setup({ prev: preview({ editable: false, seed: null }) });
    const disabled = root.querySelector('button[aria-label="Edit in ng-v0 — coming soon"]');
    expect(disabled).not.toBeNull();
    expect((disabled as HTMLButtonElement).disabled).toBe(true);
    // no editor link, and the URL builder is never consulted
    expect(byText(root, 'a.btn', 'Edit in ng-v0')).toBeUndefined();
    expect(bridge.editUrl).not.toHaveBeenCalled();
  });

  it('enables "Edit in ng-v0" as a link to the editor when editable', async () => {
    const seed = { url: 'git://api:9418/req-42', ref: 'deadbeef' };
    const { root, bridge } = await setup({ prev: preview({ editable: true, seed }) });
    const link = byText(root, 'a.btn', 'Edit in ng-v0') as HTMLAnchorElement | undefined;
    expect(link).toBeDefined();
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('href')).toBe('http://localhost:4200/chats/new?seed=REQ-42');
    expect(bridge.editUrl).toHaveBeenCalledWith('REQ-42', seed);
    // the disabled placeholder is gone
    expect(root.querySelector('button[aria-label="Edit in ng-v0 — coming soon"]')).toBeNull();
  });

  it('shows "Send back" only when a sandbox chat exists', async () => {
    const seed = { url: 'git://api:9418/req-42', ref: 'deadbeef' };
    const none = await setup({ prev: preview({ editable: true, seed }), hasChat: false });
    expect(byText(none.root, 'button', 'Send back to the factory')).toBeUndefined();

    const some = await setup({ prev: preview({ editable: true, seed }), hasChat: true });
    expect(some.bridge.findChat).toHaveBeenCalledWith('deadbeef');
    expect(byText(some.root, 'button', 'Send back to the factory')).toBeDefined();
  });

  it('surfaces the success line after a send-back', async () => {
    const seed = { url: 'git://api:9418/req-42', ref: 'deadbeef' };
    const { fixture, root, bridge } = await setup({
      prev: preview({ editable: true, seed }),
      hasChat: true,
    });
    (byText(root, 'button', 'Send back to the factory') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(bridge.sendBack).toHaveBeenCalledWith(42, 'deadbeef');
    expect(root.textContent).toContain('Sent — the factory is re-checking your edits.');
  });

  it("surfaces the server's detail text when the factory rejects the edits", async () => {
    const seed = { url: 'git://api:9418/req-42', ref: 'deadbeef' };
    const { fixture, root } = await setup({
      prev: preview({ editable: true, seed }),
      hasChat: true,
      sendResult: {
        ok: false,
        message: 'Your app moved on — re-open the editor and redo the change.',
      },
    });
    (byText(root, 'button', 'Send back to the factory') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(root.textContent).toContain(
      'Your app moved on — re-open the editor and redo the change.',
    );
    expect(root.textContent).not.toContain('re-checking your edits');
  });
});
