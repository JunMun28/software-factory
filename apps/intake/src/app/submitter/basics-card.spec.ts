import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api } from '@sf/shared';
import { Session } from '../core/session.service';
import { BasicsCard, basicsAnswered } from './basics-card';
import { IntakeDraft } from './intake-draft.service';

function row(root: HTMLElement, label: string): HTMLElement {
  const match = [...root.querySelectorAll<HTMLElement>('.brow2')].find(
    (candidate) => candidate.querySelector('.brow2__q')?.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing row: ${label}`);
  return match;
}

describe('BasicsCard', () => {
  let draft: IntakeDraft;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BasicsCard],
      providers: [
        {
          provide: Api,
          useValue: {
            apps: vi.fn(() => of([])),
            updateRequest: vi.fn(() => of({ id: 71 })),
            uploadAttachment: vi.fn((_id: number, file: File) =>
              of({
                id: 5,
                filename: file.name,
                mime: file.type,
                kind: 'image',
                size: file.size,
                source: 'interview',
                created_at: '',
              }),
            ),
          },
        },
        {
          provide: Session,
          useValue: {
            user: () => ({ name: 'Jordan D.', initials: 'JD' }),
          },
        },
      ],
    }).compileComponents();

    draft = TestBed.inject(IntakeDraft);
    draft.requestId = 71;
    draft.type = 'new';
  });

  function render(type: 'bug' | 'enh' | 'new' | 'other' = 'new') {
    draft.type = type;
    const fixture = TestBed.createComponent(BasicsCard);
    fixture.componentRef.setInput('id', 71);
    fixture.componentRef.setInput('rtype', type);
    fixture.detectChanges();
    return fixture;
  }

  it('uses plain-language request type choices', () => {
    const root = render().nativeElement as HTMLElement;
    const choices = [...row(root, 'Request').querySelectorAll('button')].map((b) =>
      b.textContent?.trim(),
    );

    expect(choices).toEqual([
      'Fix a problem',
      'Improve an app',
      'Build a new app',
      'Something else',
    ]);
  });

  it.each([
    ['bug', 'Help us understand the problem', ['App', 'Evidence', 'How often?']],
    ['enh', 'Tell us about the improvement', ['App', 'Who benefits?', 'Expected benefit']],
    ['new', 'Tell us who this is for', ['Who will use it?', 'Expected benefit']],
    ['other', 'Add a little context', ['Who is this for?', 'Expected outcome']],
  ] as const)('tailors the basics copy for %s requests', (type, title, labels) => {
    const root = render(type).nativeElement as HTMLElement;

    expect(root.querySelector('.basics__t')?.textContent?.trim()).toBe(title);
    for (const label of labels) expect(row(root, label)).toBeTruthy();
  });

  it('places a free-text affected input after the reach options', () => {
    draft.reach = 'team';
    const fixture = render();
    const affected = row(fixture.nativeElement, 'Who will use it?');
    const options = affected.querySelector('.bseg')!;
    const input = affected.querySelector<HTMLInputElement>('input');

    expect(input).not.toBeNull();
    expect(options.compareDocumentPosition(input!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    input!.value = 'Regional finance teams';
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(draft.reach).toBeNull();
    expect(draft.reachText).toBe('Regional finance teams');
  });

  it('places an always-visible impact input before the metric options', () => {
    const fixture = render();
    const impact = row(fixture.nativeElement, 'Expected benefit');
    const input = impact.querySelector<HTMLInputElement>('input');
    const options = impact.querySelector('.bseg')!;

    expect(input).not.toBeNull();
    expect(input!.compareDocumentPosition(options)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('lets a bug reporter provide a page link or add a screenshot', () => {
    const root = render('bug').nativeElement as HTMLElement;
    const evidence = row(root, 'Evidence');

    expect(evidence.querySelector('input[inputmode="url"]')?.getAttribute('placeholder')).toBe(
      'Paste a page link',
    );
    expect(evidence.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('image/*');
    expect(evidence.querySelector('button')?.textContent?.trim()).toBe('Add screenshot');
  });

  it('counts an uploaded screenshot as bug evidence when no link is provided', () => {
    draft.type = 'bug';
    draft.appName = 'Atlas';
    draft.bugFreq = 'Every time';
    draft.attachments.set([
      {
        id: 4,
        filename: 'error.png',
        mime: 'image/png',
        kind: 'image',
        size: 2048,
        source: 'interview',
        created_at: '',
      },
    ]);

    expect(basicsAnswered(draft, 'bug')).toBe(true);
  });

  it('accepts a screenshot pasted into the evidence row', async () => {
    draft.appName = 'Atlas';
    draft.bugFreq = 'Every time';
    const fixture = render('bug');
    const evidence = row(fixture.nativeElement, 'Evidence');
    const pasted = new File(['pixels'], 'pasted-screenshot.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [pasted] } });

    evidence.querySelector('.evidence')!.dispatchEvent(event);
    await fixture.whenStable();

    expect(draft.attachments().map((a) => a.filename)).toEqual(['pasted-screenshot.png']);
    expect(basicsAnswered(draft, 'bug')).toBe(true);
    const api = TestBed.inject(Api) as any;
    const savedBody = api.updateRequest.mock.calls.at(-1)?.[1];
    expect(savedBody.bug_where).toBe('Screenshot attached · happens every time');
  });

  it('allows Something else to complete without an application', () => {
    draft.type = 'other';
    draft.reachText = 'Warehouse operators';
    draft.impactMetric = 'other';
    draft.impactValue = 'Fewer manual handoffs';

    expect(basicsAnswered(draft, 'other')).toBe(true);
  });
});
