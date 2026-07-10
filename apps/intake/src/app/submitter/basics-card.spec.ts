import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api } from '@sf/shared';
import { Session } from '../core/session.service';
import { BasicsCard } from './basics-card';
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

  function render() {
    const fixture = TestBed.createComponent(BasicsCard);
    fixture.componentRef.setInput('id', 71);
    fixture.componentRef.setInput('rtype', 'new');
    fixture.detectChanges();
    return fixture;
  }

  it('places a free-text affected input after the reach options', () => {
    draft.reach = 'team';
    const fixture = render();
    const affected = row(fixture.nativeElement, "Who's affected");
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
    const impact = row(fixture.nativeElement, 'Impact');
    const input = impact.querySelector<HTMLInputElement>('input');
    const options = impact.querySelector('.bseg')!;

    expect(input).not.toBeNull();
    expect(input!.compareDocumentPosition(options)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
