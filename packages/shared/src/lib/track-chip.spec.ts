import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { TrackChip } from './kit';

@Component({
  imports: [TrackChip],
  template: `<sf-track-chip [t]="t()" [state]="state()" (correct)="clicks = clicks + 1" />`,
})
class Host {
  t = signal('bug');
  state = signal<'confident' | 'unsure' | 'pulse'>('confident');
  clicks = 0;
}

describe('TrackChip', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [Host] }));

  it('shows the type label for a bug', () => {
    const f = TestBed.createComponent(Host);
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Bug'); // TYPE_LABEL
  });

  it('shows the type label for a new app without a weight', () => {
    const f = TestBed.createComponent(Host);
    f.componentInstance.t.set('new');
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent?.toLowerCase() ?? '';
    expect(text).toContain('new app'); // TYPE_LABEL
    expect(text).not.toContain('full session');
  });

  it('carries an unsure prompt in the unsure state', () => {
    const f = TestBed.createComponent(Host);
    f.componentInstance.state.set('unsure');
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent?.toLowerCase()).toContain('what kind');
  });

  it('emits correct on click', () => {
    const f = TestBed.createComponent(Host);
    f.detectChanges();
    f.nativeElement.querySelector('button').click();
    expect(f.componentInstance.clicks).toBe(1);
  });
});
