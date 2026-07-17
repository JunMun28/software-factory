/** Attaches the Entra bearer token to factory API calls (SEC-01).
 *
 * No-op while FactoryAuth is off/unknown — dev and kind traffic is untouched.
 * Token acquisition is async (silent renew), hence the from().switchMap.
 */
import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';

import { FactoryAuth, shouldAttachToken } from './auth.service';

export const factoryAuthInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(FactoryAuth);
  if (!shouldAttachToken(req.url, auth.active)) return next(req);
  return from(auth.token()).pipe(
    switchMap((token) => next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }))),
  );
};
