import { createServer, type Server } from 'node:http';
import net from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  createPreviewBridgeProxy,
  injectDesignBridge,
  toBrowserHeaders,
  toUpstreamHeaders,
} from '../src/preview-bridge.js';

describe('injectDesignBridge', () => {
  it('injects the preview inspector before the closing body tag', () => {
    const html = '<!doctype html><html><body><main>App</main></body></html>';

    const result = injectDesignBridge(html);

    expect(result).toContain('data-ng-v0-design-bridge');
    expect(result).toContain('const __name=(target)=>target');
    expect(result).toContain('"element-selected"');
    expect(result).toContain('MutationObserver');
    expect(result).toContain('preview-element-update');
    expect(result).toContain('updateDirectText');
    expect(result).toContain('collectTextNodes');
    expect(result).toContain('textNodes.slice(1)');
    expect(result).toContain('Array.from(element.childNodes)');
    expect(result).toContain('fontSize');
    expect(result).toContain('textTransform');
    expect(result).toContain('textDecoration');
    expect(result).toContain('borderRadius');
    expect(result).toContain('let hovered = null');
    expect(result).toContain('hovered = target');
    expect(result).toContain('"mouseleave"');
    expect(result).toContain('hovered = null');
    expect(result).toContain('message.type === "hover-element"');
    expect(result).toContain('hovered = document.querySelector(message.selector)');
    expect(result).toContain('draw(hovered)');
    expect(result).not.toContain('if (!enabled || selected) return');
    // Outbound posts must not use a wildcard target once a parent origin has
    // been learned, and inbound messages from a different origin than the
    // one first observed must be dropped.
    expect(result).toContain('let trustedParentOrigin = null');
    expect(result).toContain('trustedParentOrigin ?? "*"');
    expect(result).toContain('trustedParentOrigin = event.origin');
    expect(result).toContain('event.origin !== trustedParentOrigin');
    expect(result.indexOf('data-ng-v0-design-bridge')).toBeLessThan(
      result.indexOf('</body>'),
    );
  });

  it('does not inject the bridge twice', () => {
    const once = injectDesignBridge('<html><body>App</body></html>');
    const twice = injectDesignBridge(once);

    expect(twice.match(/data-ng-v0-design-bridge/g)).toHaveLength(1);
  });
});

describe('preview bridge proxy', () => {
  it('removes credential headers at both sides of the proxy boundary', () => {
    const upstream = toUpstreamHeaders({
      authorization: 'Bearer control-plane-token',
      cookie: 'control-plane-session=secret',
      'proxy-authorization': 'Basic proxy-secret',
      'x-safe-header': 'forward-me',
    });
    const browser = toBrowserHeaders(
      new Headers({
        'set-cookie': 'generated-session=untrusted; Path=/',
        'x-generated-app': 'reachable',
      }),
    );

    expect(upstream.has('authorization')).toBe(false);
    expect(upstream.has('cookie')).toBe(false);
    expect(upstream.has('proxy-authorization')).toBe(false);
    expect(upstream.get('x-safe-header')).toBe('forward-me');
    expect(browser.has('set-cookie')).toBe(false);
    expect(browser.get('x-generated-app')).toBe('reachable');
  });

  it('does not shuttle browser credentials to or from the generated app', async () => {
    let receivedHeaders: import('node:http').IncomingHttpHeaders = {};
    const target = createServer((request, response) => {
      receivedHeaders = request.headers;
      response.setHeader('set-cookie', 'generated-session=untrusted; Path=/');
      response.setHeader('x-generated-app', 'reachable');
      response.end('ok');
    });
    const targetPort = await listen(target);
    const bridge = await createPreviewBridgeProxy().start({
      targetUrl: `http://127.0.0.1:${targetPort}`,
      port: await freePort(),
    });

    try {
      const response = await fetch(`${bridge.url}/credentials`, {
        headers: {
          authorization: 'Bearer control-plane-token',
          cookie: 'control-plane-session=secret',
          'proxy-authorization': 'Basic proxy-secret',
          'x-safe-header': 'forward-me',
        },
      });

      expect(receivedHeaders.authorization).toBeUndefined();
      expect(receivedHeaders.cookie).toBeUndefined();
      expect(receivedHeaders['proxy-authorization']).toBeUndefined();
      expect(receivedHeaders['x-safe-header']).toBe('forward-me');
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(response.headers.get('x-generated-app')).toBe('reachable');
      expect(await response.text()).toBe('ok');
    } finally {
      await bridge.close();
      target.closeAllConnections();
      target.close();
    }
  });

  // The dev server's live-reload runs over a WebSocket; the bridge must pass
  // protocol upgrades through or the preview stays frozen mid-generation.
  it('tunnels upgrade requests to the target server', async () => {
    let receivedUpgradeHeaders: import('node:http').IncomingHttpHeaders = {};
    const target = createServer((_request, response) => response.end('http-ok'));
    target.on('upgrade', (request, socket) => {
      receivedUpgradeHeaders = request.headers;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.write(`echo:${request.url}`);
    });
    const targetPort = await listen(target);

    const bridge = await createPreviewBridgeProxy().start({
      targetUrl: `http://127.0.0.1:${targetPort}`,
      port: await freePort(),
    });
    const bridgePort = Number(new URL(bridge.url).port);

    try {
      const received = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(bridgePort, '127.0.0.1', () => {
          socket.write(
            'GET /live-reload HTTP/1.1\r\n' +
              `Host: 127.0.0.1:${bridgePort}\r\n` +
              'Connection: Upgrade\r\n' +
              'Upgrade: websocket\r\n' +
              'Cookie: control-plane-session=secret\r\n' +
              'Authorization: Bearer control-plane-token\r\n' +
              'Proxy-Authorization: Basic proxy-secret\r\n\r\n',
          );
        });
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('echo:/live-reload')) {
            socket.destroy();
            resolve(data);
          }
        });
        socket.on('error', reject);
        setTimeout(() => reject(new Error(`timeout, got: ${data}`)), 5_000);
      });

      expect(received).toContain('101 Switching Protocols');
      expect(received).toContain('echo:/live-reload');
      expect(receivedUpgradeHeaders.cookie).toBeUndefined();
      expect(receivedUpgradeHeaders.authorization).toBeUndefined();
      expect(receivedUpgradeHeaders['proxy-authorization']).toBeUndefined();
    } finally {
      await bridge.close();
      target.closeAllConnections();
      target.close();
    }
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}
