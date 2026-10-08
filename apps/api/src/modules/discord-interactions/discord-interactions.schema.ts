import { z } from 'zod';

const discordUserSchema = z.object({
  id: z.string(),
  username: z.string().optional(),
});

/**
 * Minimal, permissive schema for an inbound Discord interaction. Unknown keys
 * are stripped, and only the fields the handler actually reads are required —
 * Discord grows this payload over time, so we validate the shape we depend on
 * rather than pinning the whole object.
 */
export const discordInteractionSchema = z.object({
  id: z.string().optional(),
  type: z.number().int(),
  application_id: z.string().optional(),
  token: z.string().optional(),
  data: z
    .object({
      custom_id: z.string().optional(),
      component_type: z.number().int().optional(),
    })
    .optional(),
  member: z.object({ user: discordUserSchema.optional() }).optional(),
  user: discordUserSchema.optional(),
  message: z
    .object({
      id: z.string().optional(),
      content: z.string().optional(),
    })
    .optional(),
});

export type DiscordInteractionInput = z.infer<typeof discordInteractionSchema>;
