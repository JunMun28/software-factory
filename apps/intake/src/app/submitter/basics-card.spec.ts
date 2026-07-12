import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api } from '@sf/shared';
import { Session } from '../core/session.service';
import { BasicsCard, basicsAnswered } from './basics-card';
import { IntakeDraft } from './intake-draft.service';

function section(root: HTMLElement, heading: string): HTMLElement {
  const match = [...root.querySelectorAll<HTMLElement>('.sec')].find(
    (candidate) => candidate.querySelector('h2')?.textContent?.trim() === heading,
  );
  if (!match) throw new Error(`Missing section: ${heading}`);
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

  it('offers the four plain-language request types as cards', () => {
    draft.typeConfidence = 0.3; // unsure → cards open so we can read them
    const root = render().nativeElement as HTMLElement;
    const choices = [...root.querySelectorAll('.typegrid .tcard .tl')].map((b) =>
      b.textContent?.trim(),
    );

    expect(choices).toEqual([
      'Fix a problem',
      'Improve an app',
      'Build a new app',
      'Something else',
    ]);
  });

  it('collapses the type cards behind the chip when confident', () => {
    draft.typeConfidence = 0.9;
    const root = render('bug').nativeElement as HTMLElement;
    expect(root.querySelector('sf-track-chip')).not.toBeNull();
    expect(root.querySelector('.typegrid')).toBeNull(); // cards collapsed
  });

  it('opens the type cards when the guess is unsure', () => {
    draft.typeConfidence = 0.3;
    const root = render('other').nativeElement as HTMLElement;
    expect(root.querySelector('.typegrid')).not.toBeNull(); // cards open
  });

  it('opens the cards when the chip is clicked', () => {
    draft.typeConfidence = 0.9;
    const fixture = render('bug');
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('sf-track-chip button')!.click();
    fixture.detectChanges();
    expect(root.querySelector('.typegrid')).not.toBeNull();
  });

  it.each([
    ['bug', ['Which app is this about?', 'Show us where it happens', 'How often does it happen?']],
    ['enh', ['Which app is this about?', 'Who benefits?', 'What would winning look like?']],
    ['new', ['Who feels it if this works?', 'What would winning look like?']],
    ['other', ['Who is this for?', 'What would a good outcome be?']],
  ] as const)('tailors the sections for %s requests', (type, headings) => {
    const root = render(type).nativeElement as HTMLElement;

    expect(section(root, 'What kind of request is this?')).toBeTruthy();
    for (const heading of headings) expect(section(root, heading)).toBeTruthy();
  });

  it('keeps later sections locked until the earlier ones are answered', () => {
    const root = render().nativeElement as HTMLElement;

    expect(section(root, 'Who feels it if this works?').classList).not.toContain('locked');
    expect(section(root, 'What would winning look like?').classList).toContain('locked');
  });

  it('places a free-text affected input after the blast-radius options', () => {
    draft.reach = 'team';
    const fixture = render();
    const affected = section(fixture.nativeElement, 'Who feels it if this works?');
    const options = affected.querySelector('.legend')!;
    const input = affected.querySelector<HTMLInputElement>('input.aud-free');

    expect(input).not.toBeNull();
    expect(options.compareDocumentPosition(input!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    input!.value = 'Regional finance teams';
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(draft.reach).toBeNull();
    expect(draft.reachText).toBe('Regional finance teams');
  });

  it('maps the outer blast-radius ring onto the wider reach value', () => {
    draft.reach = 'me';
    const fixture = render();
    const affected = section(fixture.nativeElement, 'Who feels it if this works?');
    const legend = [...affected.querySelectorAll<HTMLButtonElement>('.legend button')];

    legend.at(-1)!.click();
    fixture.detectChanges();

    expect(draft.reach).toBe('wider');
    // legacy site/network drafts still light the outer band
    draft.reach = 'network';
    fixture.detectChanges();
    expect(legend.at(-1)!.classList).toContain('on');
  });

  it('reveals the estimate input only after a payoff card is picked', () => {
    draft.reach = 'team';
    const fixture = render();
    const impact = section(fixture.nativeElement, 'What would winning look like?');

    expect(impact.querySelector('.imp-est')).toBeNull();

    const timeCard = [...impact.querySelectorAll<HTMLButtonElement>('.icard')].find((c) =>
      c.textContent?.includes('Saves time'),
    )!;
    timeCard.click();
    fixture.detectChanges();

    const input = impact.querySelector<HTMLInputElement>('.imp-est input')!;
    expect(input).not.toBeNull();
    expect(impact.querySelector('.impgrid')!.compareDocumentPosition(input)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    input.value = '120';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(draft.impactMetric).toBe('hours');
    expect(draft.impactValue).toBe('120');
  });

  it('lets a bug reporter provide a page link or add a screenshot', () => {
    const root = render('bug').nativeElement as HTMLElement;
    const evidence = section(root, 'Show us where it happens');

    expect(evidence.querySelector('input[inputmode="url"]')?.getAttribute('placeholder')).toBe(
      'Paste a page link',
    );
    expect(evidence.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('image/*');
    expect(evidence.querySelector('.evidence button')?.textContent?.trim()).toBe('Add screenshot');
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
    const evidence = section(fixture.nativeElement, 'Show us where it happens');
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
