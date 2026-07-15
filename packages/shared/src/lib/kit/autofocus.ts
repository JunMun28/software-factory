import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/** Reliable focus for dynamically-inserted inputs (the `autofocus` attribute only
 *  works at document parse time, not for @if-rendered overlays). */
@Directive({ selector: '[sfAutofocus]' })
export class Autofocus {
  constructor() {
    const el = inject(ElementRef);
    afterNextRender(() => el.nativeElement.focus());
  }
}
