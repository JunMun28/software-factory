import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api } from '../core/api.service';
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
});
