import { z } from 'zod';
import { requestLinkSchema, verifyLinkSchema } from '../../../api/src/modules/auth/auth.schema';

export type RequestLinkDto = z.infer<typeof requestLinkSchema>;
export type VerifyLinkDto = z.infer<typeof verifyLinkSchema>;
