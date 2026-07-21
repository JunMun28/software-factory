export interface DesignLayer {
  selector: string;
  tag: string;
  label: string;
  text?: string;
  depth: number;
  rect?: { x: number; y: number; width: number; height: number };
  styles?: Pick<DesignElementStyles, 'display' | 'position' | 'width'>;
}

export interface DesignElementStyles {
  display: string;
  position: string;
  width: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  textTransform: string;
  textDecoration: string;
  color: string;
  backgroundColor: string;
  padding: string;
  margin: string;
  borderWidth: string;
  borderStyle: string;
  borderColor: string;
  borderRadius: string;
}

export interface DesignElement extends DesignLayer {
  text: string;
  styles: DesignElementStyles;
}

export interface DesignElementPatch {
  text?: string;
  styles?: Partial<DesignElementStyles>;
}

export type DesignBridgeEvent =
  | { source: 'ng-v0-preview'; type: 'bridge-ready' }
  | { source: 'ng-v0-preview'; type: 'design-layers'; layers: DesignLayer[] }
  | { source: 'ng-v0-preview'; type: 'element-selected'; element: DesignElement };

export function isDesignBridgeEvent(value: unknown): value is DesignBridgeEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as { source?: unknown; type?: unknown };
  return event.source === 'ng-v0-preview' &&
    ['bridge-ready', 'design-layers', 'element-selected'].includes(String(event.type));
}
