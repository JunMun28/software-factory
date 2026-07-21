import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { PreviewPanel } from '../preview-panel/preview-panel';
import { DesignPanel } from './design-panel';

describe('DesignPanel', () => {
  it('renders real preview layers and selects an element for inspection', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleLayers(layers: unknown[]): void;
      handleElementSelected(element: unknown): void;
    };
    fixture.detectChanges();

    expect(typeof component.handleLayers).toBe('function');
    component.handleLayers([
      { selector: 'body > main', tag: 'main', label: 'main', depth: 1 },
      { selector: 'body > main > h1', tag: 'h1', label: 'Dashboard', depth: 2 },
    ]);
    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();

    const detailsToggle: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="toggle-design-details"]',
    );
    detailsToggle.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Dashboard');
    expect(fixture.nativeElement.textContent).toContain('body > main > h1');
    expect(fixture.nativeElement.querySelector('[aria-label="Instructions for selected element"]')).toBeTruthy();
  });

  it('keeps Design details hidden by default and preserves the explicit toggle state', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
    };
    fixture.detectChanges();
    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();

    const toggle: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="toggle-design-details"]',
    );
    expect(toggle.getAttribute('aria-label')).toBe('Show design details');
    expect(fixture.nativeElement.querySelector('[data-testid="design-details-panel"]')).toBeNull();

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-label')).toBe('Hide design details');
    expect(fixture.nativeElement.querySelector('[data-testid="design-details-panel"]')).toBeTruthy();

    component.handleElementSelected({ ...makeSelectedElement(), label: 'Another heading' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="design-details-panel"]')).toBeTruthy();

    toggle.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="design-details-panel"]')).toBeNull();
  });

  it('repositions the command bar when the details panel changes preview width', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
      annotationPosition(): { left: number; top: number };
    };
    fixture.detectChanges();

    let renderedWidth = 800;
    const previewSurface: HTMLElement = fixture.nativeElement.querySelector(
      'app-preview-panel',
    ).parentElement;
    Object.defineProperty(previewSurface, 'clientWidth', {
      configurable: true,
      get: () => renderedWidth,
    });
    Object.defineProperty(previewSurface, 'clientHeight', {
      configurable: true,
      value: 600,
    });

    component.handleElementSelected({
      ...makeSelectedElement(),
      rect: { x: 520, y: 80, width: 100, height: 40 },
    });
    expect(component.annotationPosition().left).toBe(390);

    const toggle: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="toggle-design-details"]',
    );
    toggle.click();
    fixture.detectChanges();
    queueMicrotask(() => {
      renderedWidth = 500;
    });
    await new Promise((resolve) => setTimeout(resolve));

    expect(component.annotationPosition().left).toBe(128);
  });

  it('highlights layers on hover and hides the helper after selection', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const previewHover = vi.spyOn(PreviewPanel.prototype, 'hoverElement');
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleLayers(layers: unknown[]): void;
      handleElementSelected(element: unknown): void;
    };
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="design-mode-hint"]')).toBeTruthy();
    component.handleLayers([
      { selector: 'body > main', tag: 'main', label: 'main', depth: 1 },
      { selector: 'body > main > h1', tag: 'h1', label: 'Dashboard', depth: 2 },
    ]);
    fixture.detectChanges();

    const rows: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="design-layer-row"]'),
    );
    rows[1]?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(previewHover).toHaveBeenLastCalledWith('body > main > h1');

    rows[1]?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(previewHover).toHaveBeenLastCalledWith(null);

    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="design-mode-hint"]')).toBeNull();
    const layerButtons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[data-design-layer]'),
    );
    expect(layerButtons[0]?.hasAttribute('aria-current')).toBe(false);
    expect(layerButtons[1]?.getAttribute('aria-current')).toBe('true');
  });

  it('exposes typography toggle state with aria-pressed', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
    };
    fixture.detectChanges();
    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="toggle-design-details"]').click();
    fixture.detectChanges();

    const bold: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Toggle bold"]',
    );
    const alignLeft: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Align left"]',
    );
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    expect(alignLeft.getAttribute('aria-pressed')).toBe('false');

    bold.click();
    alignLeft.click();
    fixture.detectChanges();
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    expect(alignLeft.getAttribute('aria-pressed')).toBe('true');
  });

  it('previews direct style changes and resets the selected element', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const previewUpdate = vi.spyOn(PreviewPanel.prototype, 'updateElement');
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
      resetDraft(): void;
      pending(): boolean;
    };
    fixture.detectChanges();
    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();

    const detailsToggle: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="toggle-design-details"]',
    );
    detailsToggle.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[aria-label="Font size"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[aria-label="Toggle uppercase"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[aria-label="Toggle underline"]')).toBeTruthy();
    for (const label of [
      'Font size',
      'Line height',
      'Letter spacing',
      'Padding',
      'Margin',
      'Border width',
      'Border radius',
    ]) {
      expect(
        fixture.nativeElement.querySelector(`[aria-label="Drag to adjust ${label}"]`),
      ).toBeTruthy();
    }

    const fontSizeHandle: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Drag to adjust Font size"]',
    );
    fontSizeHandle.dispatchEvent(scrubPointerEvent('pointerdown', 100));
    fontSizeHandle.dispatchEvent(scrubPointerEvent('pointermove', 108));
    fontSizeHandle.dispatchEvent(scrubPointerEvent('pointerup', 108));

    expect(component.pending()).toBe(true);
    expect(previewUpdate).toHaveBeenLastCalledWith('body > main > h1', {
      styles: { fontSize: '32px' },
    });

    component.resetDraft();
    expect(component.pending()).toBe(false);
    expect(previewUpdate).toHaveBeenLastCalledWith('body > main > h1', {
      styles: { fontSize: '30px' },
    });
  });

  it('sends a selected-element annotation to the active chat', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const chatService = TestBed.inject(ChatService);
    chatService.activeChatId.set('chat-1');
    const sendTurn = vi.spyOn(chatService, 'sendTurn').mockResolvedValue();
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
      annotationText(): string;
      canSubmitAnnotation(): boolean;
    };
    fixture.detectChanges();

    expect(typeof component.handleElementSelected).toBe('function');
    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();

    const popover: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="annotation-popover"]',
    );
    expect(popover).toBeTruthy();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector(
      '[aria-label="Comment on selected element"]',
    );
    textarea.value = 'Make this title warmer and more welcoming';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(component.annotationText()).toBe('Make this title warmer and more welcoming');
    expect(component.canSubmitAnnotation()).toBe(true);

    const apply: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="add-annotation"]',
    );
    apply.click();

    expect(sendTurn).toHaveBeenCalledOnce();
    expect(sendTurn.mock.calls[0]?.[0]).toBe('chat-1');
    expect(sendTurn.mock.calls[0]?.[1]).toContain('body > main > h1');
    expect(sendTurn.mock.calls[0]?.[1]).toContain('Make this title warmer and more welcoming');
    expect(sendTurn.mock.calls[0]?.[1]).toContain('untrusted');
  });

  it('offers functional instruction shortcuts inside the annotation popup', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
      annotationText(): string;
      instruction(): string;
    };
    fixture.detectChanges();

    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="annotation-instructions"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelectorAll('[data-testid="annotation-suggestion"]'),
    ).toHaveLength(0);
    const suggestionToggle: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="toggle-annotation-suggestions"]',
    );
    suggestionToggle.click();
    fixture.detectChanges();

    const instructions: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="annotation-instructions"]',
    );
    const suggestions: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="annotation-suggestion"]'),
    );
    expect(instructions.textContent).toContain('Instructions');
    expect(suggestions.map((button) => button.textContent?.trim())).toEqual([
      '/modern',
      '/contrast',
      '/spacious',
      '/simplify',
      '/readable',
    ]);

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector(
      '[aria-label="Comment on selected element"]',
    );
    textarea.value = 'Make it warmer';
    textarea.dispatchEvent(new Event('input'));
    suggestions[0]?.click();

    expect(component.annotationText()).toBe('Make it warmer /modern');
    expect(component.instruction()).toBe('');
  });

  it('opens a compact anchored command bar and closes with Escape', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
    };
    fixture.detectChanges();

    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();

    const popover: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="annotation-popover"]',
    );
    expect(popover).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="annotation-command-bar"]')).toBeTruthy();
    expect(
      fixture.nativeElement.querySelector('[data-testid="annotation-element-tag"]').textContent.trim(),
    ).toBe('h1');
    const input: HTMLInputElement = fixture.nativeElement.querySelector(
      '[aria-label="Comment on selected element"]',
    );
    expect(input.tagName).toBe('INPUT');
    expect(input.placeholder).toBe('Describe the change');
    expect(popover.textContent).not.toContain('body > main > h1');
    expect(popover.textContent).not.toContain('Cancel');
    expect(popover.textContent).not.toContain('Add comment');
    expect(
      fixture.nativeElement.querySelector('[data-testid="add-annotation"]').getAttribute('aria-label'),
    ).toBe('Add comment');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="annotation-popover"]')).toBeNull();
  });

  it('supports Escape to cancel and Enter to add a comment', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const chatService = TestBed.inject(ChatService);
    chatService.activeChatId.set('chat-1');
    const sendTurn = vi.spyOn(chatService, 'sendTurn').mockResolvedValue();
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
    };
    fixture.detectChanges();

    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();
    let input: HTMLInputElement = fixture.nativeElement.querySelector(
      'input[aria-label="Comment on selected element"]',
    );
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="annotation-popover"]')).toBeNull();
    expect(sendTurn).not.toHaveBeenCalled();

    component.handleElementSelected(makeSelectedElement());
    fixture.detectChanges();
    input = fixture.nativeElement.querySelector(
      'input[aria-label="Comment on selected element"]',
    );
    input.value = 'Increase the contrast';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(sendTurn).toHaveBeenCalledOnce();
    expect(sendTurn.mock.calls[0]?.[1]).toContain('Increase the contrast');
  });

  it('keeps the annotation composer inside the preview surface', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
      annotationPosition(): { left: number; top: number };
    };
    fixture.detectChanges();

    component.handleElementSelected({
      ...makeSelectedElement(),
      rect: { x: 760, y: 560, width: 100, height: 40 },
    });

    const position = component.annotationPosition();
    expect(position).toEqual({ left: 428, top: 460 });
  });

  it('places the composer below a wide element when neither side fits', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
      annotationPosition(): { left: number; top: number };
    };
    fixture.detectChanges();

    component.handleElementSelected({
      ...makeSelectedElement(),
      rect: { x: 20, y: 100, width: 760, height: 80 },
    });

    expect(component.annotationPosition().top).toBe(192);
  });

  it('applies direct content and style changes as one source-backed request', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPanel] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPanel);
    const chatService = TestBed.inject(ChatService);
    chatService.activeChatId.set('chat-1');
    const sendTurn = vi.spyOn(chatService, 'sendTurn').mockResolvedValue();
    const component = fixture.componentInstance as unknown as {
      handleElementSelected(element: unknown): void;
      updateText(value: string): void;
      updateStyle(property: string, value: string): void;
      applyChanges(): void;
    };
    fixture.detectChanges();
    component.handleElementSelected(makeSelectedElement());

    expect(typeof component.updateText).toBe('function');
    component.updateText('Performance dashboard');
    component.updateStyle('fontSize', '32px');
    component.applyChanges();

    expect(sendTurn).toHaveBeenCalledOnce();
    const prompt = sendTurn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('Content: Performance dashboard');
    expect(prompt).toContain('font-size: 32px');
    expect(prompt).toContain('untrusted="true"');
  });
});

function scrubPointerEvent(type: string, clientX: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function makeSelectedElement() {
  return {
    selector: 'body > main > h1',
    tag: 'h1',
    label: 'Dashboard',
    text: 'Dashboard',
    depth: 2,
    rect: { x: 120, y: 80, width: 320, height: 48 },
    styles: {
      display: 'block',
      position: 'static',
      width: '320px',
      fontFamily: 'system-ui',
      fontSize: '30px',
      fontWeight: '600',
      fontStyle: 'normal',
      lineHeight: '36px',
      letterSpacing: '-0.5px',
      textAlign: 'start',
      textTransform: 'none',
      textDecoration: 'none',
      color: 'rgb(13, 33, 28)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      padding: '0px',
      margin: '0px 0px 16px',
      borderWidth: '0px',
      borderStyle: 'none',
      borderColor: 'rgb(13, 33, 28)',
      borderRadius: '0px',
    },
  };
}
