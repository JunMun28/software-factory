class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {
    // jsdom has no layout engine, so observations never fire.
  }

  disconnect(): void {
    // No observer state to release.
  }

  observe(_target: Element, _options?: ResizeObserverOptions): void {
    // No layout changes to observe in jsdom.
  }

  unobserve(_target: Element): void {
    // No observed targets to release.
  }
}

globalThis.ResizeObserver = ResizeObserverStub;
