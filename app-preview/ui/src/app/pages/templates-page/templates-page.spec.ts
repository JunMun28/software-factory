import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { TemplatesPage } from './templates-page';

describe('TemplatesPage', () => {
  it('makes the unfinished community gallery visibly unavailable', async () => {
    await TestBed.configureTestingModule({
      imports: [TemplatesPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(TemplatesPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Community');
    expect(fixture.nativeElement.textContent).toContain('Community Templates');
    expect(fixture.nativeElement.textContent).toContain('Your Templates');
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Community Templates');
    expect(fixture.nativeElement.textContent).toContain(
      'Community templates are not available yet',
    );
    const search: HTMLInputElement = fixture.nativeElement.querySelector(
      '[aria-label="Search templates — coming soon"]',
    );
    expect(search.disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Categories');
    expect(fixture.nativeElement.textContent).toContain('Featured Templates');
    const cards: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[data-template-card]'),
    );
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(cards.every((card) => card.querySelector('a, button') === null)).toBe(true);
    expect(cards.every((card) => card.textContent?.includes('Coming soon'))).toBe(true);
    expect(fixture.nativeElement.querySelector('a[href="/"]')?.textContent).toContain('New Chat');
  });

  it('shows an empty Your Templates state in place', async () => {
    await TestBed.configureTestingModule({
      imports: [TemplatesPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(TemplatesPage);
    fixture.detectChanges();

    const yourTemplates: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[role="tab"][aria-label="Your Templates"]',
    );
    yourTemplates.click();
    fixture.detectChanges();

    expect(yourTemplates.getAttribute('aria-selected')).toBe('true');
    expect(fixture.nativeElement.textContent).toContain('You have no templates yet');
    expect(fixture.nativeElement.querySelector('[aria-label^="Search templates"]')).toBeNull();
  });
});
