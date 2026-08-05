/**
 * Express type augmentation.
 *
 * Declared in one place so `req.user` and `req.id` are typed everywhere without
 * each module re-declaring — duplicate `declare global` blocks that disagree are
 * a subtle source of `any`.
 */

import type { UserRole } from '@quantdesk/shared';

/** The authenticated principal attached by the auth middleware. */
export interface RequestUser {
  id: string;
  email: string;
  role: UserRole;
  /** Present when the request authenticated with an API key rather than a JWT. */
  apiKeyId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id, set by the requestId middleware. */
      id: string;
      /** Set only on authenticated requests. */
      user?: RequestUser;
    }
  }
}
