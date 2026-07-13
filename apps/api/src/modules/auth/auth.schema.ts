import { z } from 'zod';

export const requestLinkSchema = z.object({
  email: z.string().email(),
});

export const verifyLinkSchema = z.object({
  token: z.string(),
});
