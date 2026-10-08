import { z } from 'zod';

/**
 * Form fields Slack posts with every slash command invocation
 * (application/x-www-form-urlencoded). Only `command` and `user_id` are
 * strictly required by Slack; the rest are kept optional so unexpected
 * payload variations never reject a genuine request.
 */
export const slackCommandPayloadSchema = z.object({
  command: z.string().min(1),
  text: z.string().optional().default(''),
  user_id: z.string().min(1),
  user_name: z.string().optional().default(''),
  channel_id: z.string().optional(),
  team_id: z.string().optional(),
  response_url: z.string().optional(),
  api_app_id: z.string().optional(),
});

export type SlackCommandPayload = z.infer<typeof slackCommandPayloadSchema>;
