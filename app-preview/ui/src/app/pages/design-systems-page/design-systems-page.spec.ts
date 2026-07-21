import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { DesignSystemsPage } from './design-systems-page';

describe('DesignSystemsPage', () => {
  it('presents an honest unavailable state without dead controls', async () => {
    await TestBed.configureTestingModule({
      imports: [DesignSystemsPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(DesignSystemsPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Design Systems');
    expect(fixture.nativeElement.textContent).toContain(
      'Design Systems are not available yet',
    );
    expect(fixture.nativeElement.querySelector('[role="tablist"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
  });
});
