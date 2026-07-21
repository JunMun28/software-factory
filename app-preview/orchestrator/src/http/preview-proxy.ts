import type { MiddlewareHandler } from 'hono';

import { proxyPreviewResponse } from '../preview-bridge.js';
import type { PreviewManager } from '../preview-manager.js';

/**
 * Host-based preview routing for the orchestrator's MAIN server. Registered
 * BEFORE the API routes: when a request's `Host` matches a known kube preview
 * host, proxy it to that chat's in-cluster sandbox target — injecting the
 * point-to-edit overlay into HTML and filtering headers via
 * {@link proxyPreviewResponse} — and short-circuit. Otherwise fall through to
 * the API with `next()`.
 *
 * In local mode the host map is always empty, so every request falls through
 * and behaviour is unchanged.
 */
export function previewProxyMiddleware(
  previewManager: Pick<PreviewManager, 'resolvePreviewTarget'>,
): MiddlewareHandler {
  return async (c, next) => {
    const target = previewManager.resolvePreviewTarget(c.req.header('host'));
    if (!target) {
      await next();
      return;
    }
    const url = new URL(c.req.url);
    return proxyPreviewResponse(`${target}${url.pathname}${url.search}`, c.req.raw);
  };
}
