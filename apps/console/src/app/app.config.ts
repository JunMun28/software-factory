import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(),
    // The Intake app's origin for the "New request" deep-link is the INTAKE_URL
    // token (core/intake-url.ts), whose root factory holds the default. Override
    // it per environment by adding a provider here only when it differs.
  ],
};
