import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

@Component({
  imports: [SubShell],
  template: `<sub-shell><p data-testid="content">Content</p></sub-shell>`,
})
class Host {}

describe('SubShell', () => {
  beforeEach(async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
    await TestBed.configureTestingModule({ providers: [provideRouter([])] }).compileComponents();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('renders shell content without progress-stepper UI', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-testid="content"]')).not.toBeNull();
    expect(root.querySelector('.rail')).toBeNull();
    expect(root.querySelector('.railchip')).toBeNull();
    expect(root.querySelector('.proto-switcher')).toBeNull();
  });

  it('resets the in-progress draft when the "New request" nav is clicked', () => {
    const draft = TestBed.inject(IntakeDraft);
    draft.requestId = 42;
    draft.type = 'bug';
    draft.desc = 'a half-written request';
    draft.typeConfidence = 0.3;

    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const btn = [...fixture.nativeElement.querySelectorAll('button')].find(
      (b: HTMLButtonElement) => b.textContent?.trim() === 'New request',
    ) as HTMLButtonElement;
    btn.click();

    // the draft is wiped so the composer opens fresh, then we navigate to it
    expect(draft.requestId).toBeNull();
    expect(draft.type).toBeNull();
    expect(draft.desc).toBe('');
    expect(draft.typeConfidence).toBe(1);
    expect(nav).toHaveBeenCalledWith('/submit/new');
  });
});
