/** SEC-01 Entra sign-in for the SPAs (azure-entra-setup runbook, Phase 2).
 *
 * Discovery-first: the app boots by asking GET /api/auth/config. mode=off
 * (dev/kind default) means NO MSAL — the library is not even loaded, and the
 * app behaves byte-for-byte as before. mode=entra returns the tenant + client
 * ids (public identifiers, served from API env so none live in the repo or
 * the bundles), and this service then redirect-signs-in via @azure/msal-browser
 * (auth code + PKCE; no client secret exists in this design).
 *
 * The API validates every call server-side; this class only ACQUIRES tokens.
 */
import { Injectable, signal } from '@angular/core';

import type { AccountInfo, IPublicClientApplication } from '@azure/msal-browser';

export interface AuthConfig {
  mode: 'off' | 'entra';
  tenantId?: string;
  audience?: string;
  clientIds?: Record<string, string>;
}

export type FactoryAppName = 'console' | 'intake';

@Injectable({ providedIn: 'root' })
export class FactoryAuth {
  /** 'unknown' until init resolves; 'off' = no auth wall; 'entra' = signed in. */
  readonly mode = signal<'unknown' | 'off' | 'entra'>('unknown');
  readonly account = signal<AccountInfo | null>(null);
  /** Entra app roles from the ID token: admin / viewer / submitter. */
  readonly roles = signal<string[]>([]);

  private msal: IPublicClientApplication | null = null;
  private scopes: string[] = [];

  /** App-initializer entry. Resolves fast in off mode; in entra mode it may
   *  loginRedirect (navigating away) on first visit. */
  async init(appName: FactoryAppName): Promise<void> {
    let config: AuthConfig;
    try {
      const response = await fetch('/api/auth/config');
      config = (await response.json()) as AuthConfig;
    } catch {
      // API unreachable: let the app boot and surface its normal errors.
      this.mode.set('off');
      return;
    }
    if (config.mode !== 'entra') {
      this.mode.set('off');
      return;
    }
    const clientId = config.clientIds?.[appName] ?? '';
    if (!clientId || !config.tenantId || !config.audience) {
      console.error('auth: /api/auth/config says entra but is missing ids — staying signed out');
      this.mode.set('off');
      return;
    }
    this.scopes = [`${config.audience}/access_as_user`];

    const { createStandardPublicClientApplication } = await import('@azure/msal-browser');
    const msal = await createStandardPublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        redirectUri: window.location.origin,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    this.msal = msal;
    const result = await msal.handleRedirectPromise();
    const account = result?.account ?? msal.getAllAccounts()[0] ?? null;
    if (!account) {
      await msal.loginRedirect({ scopes: this.scopes });
      // The page is navigating to the sign-in — never resolve, so the app
      // initializer keeps Angular from bootstrapping and firing naked /api
      // calls in the gap (observed live: brief 401 bursts pre-redirect).
      return new Promise<never>(() => undefined);
    }
    msal.setActiveAccount(account);
    this.account.set(account);
    this.roles.set(((account.idTokenClaims as { roles?: string[] })?.roles ?? []) as string[]);
    this.mode.set('entra');
  }

  /** True once entra sign-in completed — the interceptor's gate. */
  get active(): boolean {
    return this.mode() === 'entra';
  }

  /** An access token for the factory API; silently renewed, redirect on
   *  expiry of the refresh session (never resolves in that case). */
  async token(): Promise<string> {
    if (!this.msal) throw new Error('auth: token() before init');
    const account = this.msal.getActiveAccount() ?? undefined;
    try {
      const result = await this.msal.acquireTokenSilent({ scopes: this.scopes, account });
      return result.accessToken;
    } catch {
      await this.msal.acquireTokenRedirect({ scopes: this.scopes });
      // The page is navigating away; hold the caller forever rather than
      // resolving with no token.
      return new Promise<never>(() => undefined);
    }
  }

  signOut(): void {
    void this.msal?.logoutRedirect();
  }
}

/** Which requests carry a bearer token: factory API calls only, minus the
 *  discovery endpoint itself (open by design, and fetched pre-token anyway).
 *  Exported for the spec. */
export function shouldAttachToken(url: string, active: boolean): boolean {
  return active && url.startsWith('/api') && !url.startsWith('/api/auth/config');
}
