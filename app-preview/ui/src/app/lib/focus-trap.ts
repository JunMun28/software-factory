import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  OnDestroy,
  Output,
  inject,
} from '@angular/core';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

@Directive({
  selector: '[focusTrap]',
})
export class FocusTrap implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);
  private readonly previouslyFocused =
    this.document.activeElement instanceof HTMLElement ? this.document.activeElement : null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  @Output() readonly focusTrapEscape = new EventEmitter<void>();

  ngAfterViewInit(): void {
    this.focusTimer = setTimeout(() => {
      const preferred = this.host.querySelector<HTMLElement>('[autoFocusTarget]');
      const target = preferred ?? this.focusableElements()[0] ?? this.host;
      if (target === this.host && !this.host.hasAttribute('tabindex')) {
        this.host.tabIndex = -1;
      }
      target.focus();
    });
  }

  ngOnDestroy(): void {
    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
    }
    this.previouslyFocused?.focus();
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.focusTrapEscape.emit();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusable = this.focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      this.host.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable.at(-1)!;
    const active = this.document.activeElement;

    if (event.shiftKey && (active === first || !this.host.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.host.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusableElements(): HTMLElement[] {
    return Array.from(this.host.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) =>
        !element.hidden &&
        element.getAttribute('aria-hidden') !== 'true' &&
        !element.closest('[inert]') &&
        element.tabIndex >= 0,
    );
  }
}
