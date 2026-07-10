import { z } from 'zod';

export const createWalletSchema = z.object({
  userId: z.string(), 
  publicKey: z.string().length(56).startsWith('G'),
  label: z.string().optional(),
});

export const deleteWalletSchema = z.object({
  id: z.string(),
});
