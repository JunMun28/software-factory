import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import net from 'node:net';

const BRIDGE_ATTRIBUTE = 'data-ng-v0-design-bridge';
const CREDENTIAL_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
]);
const BLOCKED_UPSTREAM_REQUEST_HEADERS = new Set([
  'host',
  'accept-encoding',
  'content-length',
  'connection',
  ...CREDENTIAL_REQUEST_HEADERS,
]);
const BLOCKED_BROWSER_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'set-cookie',
]);

export interface PreviewBridgeHandle {
  url: string;
  close(): Promise<void>;
}

export interface PreviewBridgeProxy {
  start(input: { targetUrl: string; port: number }): Promise<PreviewBridgeHandle>;
}

export function createPreviewBridgeProxy(): PreviewBridgeProxy {
  return {
    async start({ targetUrl, port }) {
      const server = createServer((request, response) => {
        void proxyRequest(server, targetUrl, request, response);
      });

      // The dev server pushes rebuild/reload signals over a WebSocket; tunnel
      // upgrades through so the preview live-updates while the agent works.
      // Upgraded sockets escape closeAllConnections, so track them here or
      // close() waits on live-reload connections forever.
      const upgradedSockets = new Set<import('node:stream').Duplex>();
      server.on('upgrade', (request, socket, head) => {
        upgradedSockets.add(socket);
        socket.on('close', () => upgradedSockets.delete(socket));
        tunnelUpgrade(targetUrl, request, socket, head);
      });

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });

      return {
        url: `http://localhost:${port}`,
        close: () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
            for (const socket of upgradedSockets) {
              socket.destroy();
            }
          }),
      };
    },
  };
}

export function injectDesignBridge(html: string): string {
  if (html.includes(BRIDGE_ATTRIBUTE)) {
    return html;
  }

  // tsx/esbuild preserves function names with a tiny __name helper when
  // stringifying this function. Define the helper inside the injected page so
  // the standalone bridge runs without depending on the orchestrator bundle.
  const script = `<script ${BRIDGE_ATTRIBUTE}>const __name=(target)=>target;(${designBridgeRuntime.toString()})();</script>`;
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${script}</body>`)
    : `${html}${script}`;
}

function tunnelUpgrade(
  targetUrl: string,
  request: import('node:http').IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
): void {
  const target = new URL(targetUrl);
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const key = request.rawHeaders[i];
      const value = request.rawHeaders[i + 1];
      const lowerKey = key.toLowerCase();
      if (CREDENTIAL_REQUEST_HEADERS.has(lowerKey)) {
        continue;
      }
      lines.push(lowerKey === 'host' ? `${key}: ${target.host}` : `${key}: ${value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}

async function proxyRequest(
  _server: Server,
  targetUrl: string,
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
): Promise<void> {
  try {
    const headers = toUpstreamHeaders(request.headers);
    const method = request.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request);
    const upstream = await fetch(new URL(request.url ?? '/', targetUrl), {
      method,
      headers,
      body: body as unknown as BodyInit | undefined,
      redirect: 'manual',
    });

    response.statusCode = upstream.status;
    toBrowserHeaders(upstream.headers).forEach((value, key) => {
      response.setHeader(key, value);
    });

    const contentType = upstream.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      response.setHeader('content-type', contentType);
      response.end(injectDesignBridge(await upstream.text()));
      return;
    }

    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.statusCode = 502;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(error instanceof Error ? error.message : 'Preview bridge failed');
  }
}

export function toUpstreamHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (!value || BLOCKED_UPSTREAM_REQUEST_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

export function toBrowserHeaders(input: Headers): Headers {
  const headers = new Headers();
  input.forEach((value, key) => {
    if (!BLOCKED_BROWSER_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

async function readBody(request: import('node:http').IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function designBridgeRuntime(): void {
  const PREVIEW_SOURCE = 'ng-v0-preview';
  const PARENT_SOURCE = 'ng-v0';
  const OVERLAY_ID = 'ng-v0-design-highlight';
  let enabled = false;
  let selected: Element | null = null;
  let hovered: Element | null = null;
  // Learned from the first valid inbound message (see the message listener
  // below) since the runtime is injected with no access to orchestrator or
  // parent-page variables. Until then, 'bridge-ready' has to go out with a
  // wildcard target -- it carries no sensitive data, unlike every later post.
  let trustedParentOrigin: string | null = null;

  const post = (message: Record<string, unknown>) => {
    window.parent.postMessage(
      { source: PREVIEW_SOURCE, ...message },
      trustedParentOrigin ?? '*',
    );
  };

  const selectorFor = (element: Element): string => {
    if (element === document.body) return 'body';
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.body) {
      let part = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child: Element) => child.tagName === current?.tagName,
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return ['body', ...parts].join(' > ');
  };

  const directText = (element: Element): string =>
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 120);

  const depthOf = (element: Element): number => {
    let depth = 0;
    let current = element.parentElement;
    while (current && current !== document.body) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  };

  const describe = (element: Element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const text = directText(element);
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      label:
        text ||
        element.getAttribute('aria-label') ||
        element.getAttribute('role') ||
        element.id ||
        element.tagName.toLowerCase(),
      text,
      depth: depthOf(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: {
        display: style.display,
        position: style.position,
        width: style.width,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textAlign: style.textAlign,
        textTransform: style.textTransform,
        textDecoration: style.textDecorationLine,
        color: style.color,
        backgroundColor: style.backgroundColor,
        padding: style.padding,
        margin: style.margin,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
      },
    };
  };

  const collectTextNodes = (root: Node): Node[] => {
    const textNodes: Node[] = [];
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        textNodes.push(child);
      } else if (child instanceof Element) {
        textNodes.push(...collectTextNodes(child));
      }
    }
    return textNodes;
  };

  const updateDirectText = (element: Element, text: string) => {
    const textNodes = collectTextNodes(element);
    if (textNodes[0]) {
      textNodes[0].textContent = text;
      for (const textNode of textNodes.slice(1)) {
        textNode.textContent = '';
      }
    } else {
      element.insertBefore(document.createTextNode(text), element.firstChild);
    }
  };

  const editableStyleProperties = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'letterSpacing',
    'textAlign',
    'textTransform',
    'textDecoration',
    'color',
    'backgroundColor',
    'padding',
    'margin',
    'borderWidth',
    'borderStyle',
    'borderColor',
    'borderRadius',
  ];

  const cssProperty = (property: string): string =>
    property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

  const selectableElements = (): Element[] =>
    [document.body, ...Array.from(document.body.querySelectorAll('*'))]
      .filter((element) => {
        if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT'].includes(element.tagName)) return false;
        if (element.id === OVERLAY_ID || element.closest(`#${OVERLAY_ID}`)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
      })
      .slice(0, 300);

  const sendLayers = () => {
    post({ type: 'design-layers', layers: selectableElements().map(describe) });
  };

  const overlay = (): HTMLDivElement => {
    let element = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
    if (!element) {
      element = document.createElement('div');
      element.id = OVERLAY_ID;
      Object.assign(element.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483647',
        border: '2px solid #3b82f6',
        background: 'rgba(59, 130, 246, 0.08)',
        boxSizing: 'border-box',
        borderRadius: '3px',
      });
      document.documentElement.appendChild(element);
    }
    return element;
  };

  const draw = (element: Element | null) => {
    const highlight = overlay();
    if (!enabled || !element) {
      highlight.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };

  const select = (element: Element) => {
    selected = element;
    draw(element);
    post({ type: 'element-selected', element: describe(element) });
  };

  document.addEventListener(
    'mousemove',
    (event) => {
      if (!enabled) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && target.id !== OVERLAY_ID) {
        hovered = target;
        draw(target);
      }
    },
    true,
  );

  document.addEventListener(
    'mouseleave',
    () => {
      hovered = null;
      draw(selected);
    },
    true,
  );

  document.addEventListener(
    'click',
    (event) => {
      if (!enabled) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.id === OVERLAY_ID) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      select(target);
    },
    true,
  );

  window.addEventListener('scroll', () => draw(hovered ?? selected), true);
  window.addEventListener('resize', () => draw(hovered ?? selected));
  let layerRefreshTimer: number | undefined;
  const observer = new MutationObserver(() => {
    if (!enabled) return;
    window.clearTimeout(layerRefreshTimer);
    layerRefreshTimer = window.setTimeout(sendLayers, 50);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.source !== PARENT_SOURCE) return;
    // event.origin is set by the browser from the sender's real origin and
    // cannot be forged by page content, so the first valid message pins the
    // parent origin for good; anything claiming to be the parent from a
    // different origin afterwards (e.g. the preview iframe got navigated to
    // an attacker page that still holds the same window reference) is
    // dropped instead of trusted.
    if (trustedParentOrigin === null) {
      trustedParentOrigin = event.origin;
    } else if (event.origin !== trustedParentOrigin) {
      return;
    }
    if (message.type === 'design-mode') {
      enabled = Boolean(message.enabled);
      selected = null;
      hovered = null;
      draw(null);
      if (enabled) sendLayers();
    }
    if (message.type === 'select-element' && typeof message.selector === 'string') {
      const element = document.querySelector(message.selector);
      if (element) select(element);
    }
    if (message.type === 'hover-element') {
      if (typeof message.selector === 'string') {
        hovered = document.querySelector(message.selector);
        draw(hovered);
      } else {
        hovered = null;
        draw(selected);
      }
    }
    if (message.type === 'set-element-visibility' && typeof message.selector === 'string') {
      const element = document.querySelector(message.selector) as HTMLElement | null;
      if (element) {
        element.style.visibility = message.visible === false ? 'hidden' : '';
        sendLayers();
      }
    }
    if (message.type === 'preview-element-update' && typeof message.selector === 'string') {
      const element = document.querySelector(message.selector) as HTMLElement | null;
      if (element) {
        if (typeof message.text === 'string') {
          updateDirectText(element, message.text);
        }
        if (message.styles && typeof message.styles === 'object') {
          for (const [property, value] of Object.entries(message.styles)) {
            if (
              editableStyleProperties.includes(property) &&
              typeof value === 'string'
            ) {
              element.style.setProperty(cssProperty(property), value);
            }
          }
        }
        selected = element;
        draw(element);
        sendLayers();
      }
    }
  });

  post({ type: 'bridge-ready' });
}
