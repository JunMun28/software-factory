import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog';

describe('ConfirmDialog', () => {
  it('renders the title and description', async () => {
    const fixture = await createFixture();

    expect(fixture.nativeElement.querySelector('h2').textContent.trim()).toBe('Delete project?');
    expect(fixture.nativeElement.querySelector('p').textContent.trim()).toBe(
      'This action cannot be undone.',
    );
  });

  it('emits confirmed when the confirm button is clicked', async () => {
    const fixture = await createFixture();
    const confirmed = vi.fn();
    fixture.componentInstance.confirmed.subscribe(confirmed);

    fixture.nativeElement.querySelector('[data-confirm-dialog-confirm]').click();

    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('blocks dismissal and disables confirmation while busy', async () => {
    const fixture = await createFixture();
    const dismissed = vi.fn();
    fixture.componentInstance.dismissed.subscribe(dismissed);
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();

    const confirmButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-confirm-dialog-confirm]',
    );
    expect(confirmButton.disabled).toBe(true);

    fixture.nativeElement.querySelector('[data-confirm-dialog-cancel]').click();
    fixture.nativeElement.querySelector('[data-confirm-dialog-backdrop]').click();

    expect(dismissed).not.toHaveBeenCalled();
  });
});

async function createFixture() {
  await TestBed.configureTestingModule({ imports: [ConfirmDialog] }).compileComponents();
  const fixture = TestBed.createComponent(ConfirmDialog);
  fixture.componentRef.setInput('title', 'Delete project?');
  fixture.componentRef.setInput('description', 'This action cannot be undone.');
  fixture.detectChanges();
  return fixture;
}
