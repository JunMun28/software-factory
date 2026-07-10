import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api, Attachment } from '@sf/shared';
import { Session } from '../core/session.service';
import { IntakeDraft } from './intake-draft.service';

function mockSession() {
  return {
    user: () => ({
      name: 'Jordan D.',
      initials: 'JD',
      color: '#7A',
      email: 'j@example.com',
      role: 'submitter',
    }),
  };
}

function mockApi() {
  return {
    createRequest: vi.fn(() => of({ id: 42 } as any)),
    updateRequest: vi.fn(() => of({ id: 42 } as any)),
    uploadAttachment: vi.fn(() => of({} as Attachment)),
    deleteAttachment: vi.fn(() => of(undefined)),
    request: vi.fn(() => of({ id: 7, attachments: [] } as any)),
  };
}

describe('IntakeDraft', () => {
  let api: ReturnType<typeof mockApi>;
  let draft: IntakeDraft;

  beforeEach(() => {
    api = mockApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: Api, useValue: api },
        { provide: Session, useValue: mockSession() },
      ],
    });
    draft = TestBed.inject(IntakeDraft);
  });

  it('first save() POSTs and stores the returned requestId', async () => {
    draft.type = 'enh';
    draft.title = 'My feature';
    await draft.save();
    expect(api.createRequest).toHaveBeenCalledOnce();
    expect(api.updateRequest).not.toHaveBeenCalled();
    expect(draft.requestId).toBe(42);
  });

  it('second save() PATCHes with the stored id and does not POST again', async () => {
    draft.type = 'enh';
    draft.title = 'My feature';
    await draft.save();
    await draft.save();
    expect(api.createRequest).toHaveBeenCalledOnce();
    expect(api.updateRequest).toHaveBeenCalledOnce();
    expect((api.updateRequest.mock.calls as any[][])[0][0]).toBe(42);
  });

  it('bug type sends reach:null and impact fields as null even when set', async () => {
    draft.type = 'bug';
    draft.reach = 'team';
    draft.reachText = 'all of Penang';
    draft.impactMetric = 'hours';
    draft.impactValue = '10';
    await draft.save();
    const body = (api.createRequest.mock.calls as any[][])[0][0];
    expect(body.reach).toBeNull();
    expect(body.impact_metric).toBeNull();
    expect(body.impact_value).toBeNull();
  });

  it('persists screenshot-only bug evidence alongside frequency', async () => {
    draft.type = 'bug';
    draft.bugFreq = 'Every time';
    draft.attachments.set([
      {
        id: 9,
        filename: 'broken-screen.png',
        mime: 'image/png',
        kind: 'image',
        size: 128,
        source: 'interview',
        created_at: '',
      },
    ]);

    await draft.save();

    const body = (api.createRequest.mock.calls as any[][])[0][0];
    expect(body.bug_where).toBe('Screenshot attached · happens every time');
  });

  it('free-text reach wins over chip value', async () => {
    draft.type = 'enh';
    draft.reach = 'team';
    draft.reachText = 'all of Penang';
    await draft.save();
    const body = (api.createRequest.mock.calls as any[][])[0][0];
    expect(body.reach).toBe('all of Penang');
  });

  it('impact is null when impactValue is blank (incomplete pair)', async () => {
    draft.type = 'enh';
    draft.impactMetric = 'hours';
    draft.impactValue = '';
    await draft.save();
    const body = (api.createRequest.mock.calls as any[][])[0][0];
    expect(body.impact_metric).toBeNull();
    expect(body.impact_value).toBeNull();
  });

  it('failed createRequest rejects save() and leaves requestId null', async () => {
    api.createRequest.mockReturnValue(throwError(() => new Error('boom')));
    draft.type = 'enh';
    await expect(draft.save()).rejects.toThrow('boom');
    expect(draft.requestId).toBeNull();
    // retry should POST again (not PATCH)
    api.createRequest.mockReturnValue(of({ id: 99 } as any));
    await draft.save();
    expect(api.createRequest).toHaveBeenCalledTimes(2);
    expect(draft.requestId).toBe(99);
  });

  it('reset() clears all fields back to initial state', async () => {
    draft.type = 'enh';
    draft.title = 'Test';
    draft.reach = 'team';
    draft.reachText = 'all of Penang';
    draft.impactMetric = 'hours';
    draft.impactValue = '10';
    draft.urgency = 'high';
    await draft.save(); // sets requestId
    draft.reset();
    expect(draft.requestId).toBeNull();
    expect(draft.type).toBeNull();
    expect(draft.reach).toBeNull();
    expect(draft.reachText).toBe('');
    expect(draft.impactMetric).toBeNull();
    expect(draft.impactValue).toBe('');
    expect(draft.urgency).toBe('normal');
  });

  it('stages files when no request exists yet, then uploads on uploadPending', async () => {
    const uploaded: { rid: number; name: string }[] = [];
    api.uploadAttachment = ((rid: number, file: File) => {
      uploaded.push({ rid, name: file.name });
      return of({
        id: uploaded.length,
        filename: file.name,
        mime: 'text/plain',
        kind: 'doc',
        size: file.size,
        source: 'describe',
        created_at: '',
      } as Attachment);
    }) as any;
    draft.requestId = null;
    await draft.addFiles([new File(['x'], 'a.log')], 'describe');
    expect(draft.pending().length).toBe(1);
    expect(uploaded.length).toBe(0);

    await draft.uploadPending(42);
    expect(uploaded).toEqual([{ rid: 42, name: 'a.log' }]);
    expect(draft.pending().length).toBe(0);
    expect(draft.attachments().length).toBe(1);
  });

  it('uploads immediately when a request already exists', async () => {
    let called = 0;
    api.uploadAttachment = (() => {
      called++;
      return of({
        id: 1,
        filename: 'a.log',
        mime: 'text/plain',
        kind: 'doc',
        size: 1,
        source: 'interview',
        created_at: '',
      } as Attachment);
    }) as any;
    draft.requestId = 7;
    await draft.addFiles([new File(['x'], 'a.log')], 'interview');
    expect(called).toBe(1);
    expect(draft.attachments().length).toBe(1);
  });

  it('rejects a file over the size cap without calling the api', async () => {
    let called = 0;
    api.uploadAttachment = (() => {
      called++;
      return of({} as Attachment);
    }) as any;
    draft.requestId = 7;
    const big = new File([new Uint8Array(1)], 'big.png');
    Object.defineProperty(big, 'size', { value: 100 * 1024 * 1024 + 1 });
    await draft.addFiles([big], 'describe');
    expect(called).toBe(0);
    expect(draft.lastError()).toContain('too large');
  });

  it('loadAttachments(rid) sets requestId before fetching', async () => {
    expect(draft.requestId).toBeNull();
    await draft.loadAttachments(7);
    expect(draft.requestId).toBe(7);
    expect(api.request).toHaveBeenCalledWith(7);
    expect(draft.attachments()).toEqual([]);
  });
});
