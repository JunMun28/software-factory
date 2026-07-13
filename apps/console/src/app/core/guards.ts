import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';

import { Session } from './session.service';

/** The role fork, enforced: Submitters never reach the Control center. */
export const adminGuard: CanActivateFn = () => {
  const session = inject(Session);
  const router = inject(Router);
  return session.resolve().pipe(map((operator) => (operator ? true : router.parseUrl('/studio'))));
};
