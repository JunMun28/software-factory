import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { FactoryAuth, factoryAuthInterceptor } from '@sf/shared';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([factoryAuthInterceptor])),
    // SEC-01: auth discovery before first render. FACTORY_AUTH=off on the API
    // (the dev/kind default) resolves instantly with no MSAL loaded.
    provideAppInitializer(() => inject(FactoryAuth).init('intake')),
  ],
};
