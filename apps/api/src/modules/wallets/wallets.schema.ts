import { z } from 'zod';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
import { cursorSchema, limitSchema } from '../../utils/pagination';

export const tagSchema = z
  .string()
  .trim()
  .min(1, 'Tag must not be empty')
  .max(50, 'Tag must be at most 50 characters');

export const tagsSchema = z.array(tagSchema).max(20, 'A wallet can have at most 20 tags');

export const createWalletSchema = z.object({
  publicKey: z.string().refine((val) => isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public key format or checksum',
  }),
  label: z.string().optional(),
  tags: tagsSchema.optional(),
  zkProof: z.any().optional(),
  publicSignals: z.array(z.string()).optional(),
});

export const updateWalletSchema = z.object({
  label: z.string().optional(),
  tags: tagsSchema.optional(),
});

export const deleteWalletSchema = z.object({
  id: z.string(),
});

export const listWalletsQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
  tag: tagSchema.optional(),
});
