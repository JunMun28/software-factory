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
    provideAppInitializer(() => inject(FactoryAuth).init('console')),
    // The Intake app's origin for the "New request" deep-link is the INTAKE_URL
    // token (core/intake-url.ts), whose root factory holds the default. Override
    // it per environment by adding a provider here only when it differs.
  ],
};
