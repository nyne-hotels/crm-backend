import type { StaffRole } from './permissions.js';

export interface SignedInStaff {
  id: number;
  authUserId: string;
  username: string;
  firstName: string;
  lastName: string | null;
  role: StaffRole;
  propertyId: string | null;
  mustChangePassword: boolean;
}

declare module 'express' {
  interface Request {
    staff?: SignedInStaff;
  }
}
