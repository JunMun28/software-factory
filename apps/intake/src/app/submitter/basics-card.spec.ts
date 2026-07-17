import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api } from '@sf/shared';
import { Session } from '../core/session.service';
import { BasicsCard, basicsAnswered } from './basics-card';
import { IntakeDraft } from './intake-draft.service';

/** jump the wizard to the named question and return its rendered step */
function showStep(fixture: ComponentFixture<BasicsCard>, key: string): HTMLElement {
  const card = fixture.componentInstance;
  const i = card.steps().indexOf(key);
  if (i === -1) throw new Error(`No such question for this type: ${key}`);
  card.goStep(i);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.qstep')!;
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
    draft.typeConfidence = 0.6; // inferred, not an explicit pick — the wizard starts on Type
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

  it('shows one question at a time, starting on the type question', () => {
    const root = render().nativeElement as HTMLElement;

    expect(root.querySelectorAll('.qstep')).toHaveLength(1);
    expect(root.querySelector('.qstep h2')?.textContent?.trim()).toBe(
      'What kind of request is this?',
    );
  });

  it('never pre-selects a type card from the inferred type', () => {
    draft.typeConfidence = 0.95; // even a confident guess is not a selection
    const root = render('bug').nativeElement as HTMLElement;

    expect(root.querySelector('.qstep h2')?.textContent?.trim()).toBe(
      'What kind of request is this?',
    );
    expect(root.querySelector('.tcard.sel')).toBeNull();
  });

  it('requires an explicit pick even on a hydrated reload', () => {
    draft.typeConfidence = 1; // reload hydration — the stored type is still only inferred
    const fixture = render('bug');
    const step = showStep(fixture, 'type');

    expect(step.querySelector('.tcard.sel')).toBeNull();
    // and the wizard starts here: forward dots stay locked until the pick
    const dots = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.wiz__dots .dot',
      ),
    ];
    expect(dots[1].disabled).toBe(true);
  });

  it('advances to the next question when a type card is clicked', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    const newApp = [...root.querySelectorAll<HTMLButtonElement>('.tcard')].find((c) =>
      c.textContent?.includes('Build a new app'),
    )!;

    newApp.click();
    fixture.detectChanges();

    expect(root.querySelector('.qstep h2')?.textContent?.trim()).toBe('Who is this for?');
  });

  it.each([
    ['bug', ['Which app is this about?', 'Show us where it happens', 'How often does it happen?']],
    ['enh', ['Which app is this about?', 'Who benefits?', 'What would winning look like?']],
    ['new', ['Who is this for?', 'What is the business value?']],
    ['other', ['Who is this for?', 'What would a good outcome be?']],
  ] as const)('tailors the questions for %s requests', (type, headings) => {
    const fixture = render(type);
    const steps = fixture.componentInstance.steps();

    expect(steps[0]).toBe('type');
    const seen = steps.slice(1).map((key) => showStep(fixture, key).querySelector('h2')!);
    expect(seen.map((h) => h.textContent?.trim())).toEqual(headings);
  });

  it('keeps forward dots disabled until the earlier questions are answered', () => {
    const root = render().nativeElement as HTMLElement;
    const dots = [...root.querySelectorAll<HTMLButtonElement>('.wiz__dots .dot')];

    expect(dots).toHaveLength(3); // type · audience · impact
    expect(dots[0].disabled).toBe(false);
    expect(dots[1].disabled).toBe(true);
    expect(dots[2].disabled).toBe(true);
  });

  it('auto-advances to the next question once a ring is picked (no Next button)', () => {
    const fixture = render();
    const step = showStep(fixture, 'aud');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.wiz__next')).toBeNull();

    step.querySelectorAll<SVGCircleElement>('.ring-band')[2].dispatchEvent(new Event('click'));
    fixture.detectChanges();

    expect(root.querySelector('.qstep h2')?.textContent?.trim()).toBe(
      'What is the business value?',
    );
  });

  it('places a free-text affected input after the blast-radius options', () => {
    draft.reach = 'team';
    const fixture = render();
    const affected = showStep(fixture, 'aud');
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
    const affected = showStep(fixture, 'aud');
    const legend = [...affected.querySelectorAll<HTMLButtonElement>('.legend button')];

    legend.at(-1)!.click();
    fixture.detectChanges();

    expect(draft.reach).toBe('wider');
    // legacy site/network drafts still light the outer band (the answer
    // auto-advanced the wizard, so step back before re-reading the legend)
    draft.reach = 'network';
    const reopened = showStep(fixture, 'aud');
    const outer = [...reopened.querySelectorAll<HTMLButtonElement>('.legend button')].at(-1)!;
    expect(outer.classList).toContain('on');
  });

  it('reveals the estimate input only after a payoff card is picked', () => {
    draft.reach = 'team';
    const fixture = render();
    const impact = showStep(fixture, 'impact');

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
    const fixture = render('bug');
    const evidence = showStep(fixture, 'evidence');

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
    const evidence = showStep(fixture, 'evidence');
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
