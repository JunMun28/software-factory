import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { INTAKE_URL } from './core/intake-url';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(),
    // Where the console's "New request" deep-links to (ADR 0017 / DRE-14). This
    // is the single per-environment knob for the Intake app's origin — change it
    // here (or override the token in a deployment-specific config) without
    // touching the shell. Local dev matches `make dev`'s intake port (:4201).
    { provide: INTAKE_URL, useValue: 'http://localhost:4201' },
  ],
};
