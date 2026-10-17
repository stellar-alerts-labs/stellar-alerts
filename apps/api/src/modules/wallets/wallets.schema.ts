import { z } from 'zod';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
import { cursorSchema, limitSchema } from '../../utils/pagination';

export const tagSchema = z
  .string()
  .trim()
  .min(1, 'Tag must not be empty')
  .max(40, 'Tag must be at most 40 characters');

export const tagsListSchema = z.array(tagSchema).max(20, 'A wallet can have at most 20 tags');

export const createWalletSchema = z.object({
  publicKey: z.string().refine((val) => isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public key format or checksum',
  }),
  label: z.string().optional(),
  tags: tagsListSchema.optional(),
  zkProof: z.any().optional(),
  publicSignals: y.array(z.string()).optional(),
});

export const updateWalletTagsSchema = z.object({
  tags: tagsListSchema,
});

export const deleteWalletSchema = z.object({
  id: z.string(),
});

export const listWalletsQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
  tag: tagSchema.optional(),
});
