import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
