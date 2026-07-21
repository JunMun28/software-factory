import { describe, expect, it } from 'vitest';

import type { DesignElement } from '../preview-panel/design-bridge';
import {
  buildDesignAnnotationPrompt,
  buildDesignPrompt,
  createDesignDraft,
  diffDesignDraft,
  hasDesignChanges,
  toHexColor,
} from './design-draft';

const selectedElement: DesignElement = {
  selector: 'body > main > h1',
  tag: 'h1',
  label: 'Dashboard',
  text: 'Dashboard',
  depth: 2,
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

describe('design draft', () => {
  it('normalizes computed RGB colors for native color controls', () => {
    expect(toHexColor('rgb(13, 33, 28)')).toBe('#0d211c');
    expect(toHexColor('#ABCDEF')).toBe('#abcdef');
  });

  it('renders fully transparent colors as no color instead of black', () => {
    expect(toHexColor('rgba(0, 0, 0, 0)')).toBe('');
    expect(toHexColor('rgba(255, 255, 255, 0)')).toBe('');
    expect(toHexColor('rgb(0 0 0 / 0%)')).toBe('');
    expect(toHexColor('transparent')).toBe('');
    // Partial transparency still resolves to a usable swatch color.
    expect(toHexColor('rgba(255, 255, 255, 0.5)')).toBe('#ffffff');
  });

  it('creates a draft and reports only changed content and styles', () => {
    const original = createDesignDraft(selectedElement);
    const draft = {
      ...original,
      text: 'Performance dashboard',
      styles: { ...original.styles, fontSize: '32px' },
    };

    expect(original.styles.color).toBe('#0d211c');
    expect(diffDesignDraft(original, draft)).toEqual({
      text: 'Performance dashboard',
      styles: { fontSize: '32px' },
    });
    expect(hasDesignChanges(original, original, '')).toBe(false);
    expect(hasDesignChanges(original, original, 'Make it clearer')).toBe(true);
  });

  it('builds a structured source-backed prompt with untrusted edit data', () => {
    const original = createDesignDraft(selectedElement);
    const draft = {
      ...original,
      text: 'Performance dashboard',
      styles: { ...original.styles, fontSize: '32px', textAlign: 'center' },
    };

    const prompt = buildDesignPrompt(
      selectedElement,
      original,
      draft,
      'Keep this responsive',
    );

    expect(prompt).toContain('body > main > h1');
    expect(prompt).toContain('Content: Performance dashboard');
    expect(prompt).toContain('font-size: 32px');
    expect(prompt).toContain('text-align: center');
    expect(prompt).toContain('Keep this responsive');
    expect(prompt).toContain('Direct CSS values are exact for the current viewport');
    expect(prompt).toContain('untrusted="true"');
  });

  it('builds a selected-element annotation prompt for the active chat', () => {
    const prompt = buildDesignAnnotationPrompt(
      selectedElement,
      'Make this title warmer and more welcoming',
    );

    expect(prompt).toContain('body > main > h1');
    expect(prompt).toContain('Element: <h1>');
    expect(prompt).toContain('Current text: Dashboard');
    expect(prompt).toContain('Make this title warmer and more welcoming');
    expect(prompt).toContain('<design_annotation untrusted="true">');
    expect(prompt).toContain('Locate the matching element in the source');
  });
});
