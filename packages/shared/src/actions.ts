import { z } from 'zod';

export const ClientActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fold') }),
  z.object({ type: z.literal('check') }),
  z.object({ type: z.literal('call') }),
  z.object({ type: z.literal('raise'), amount: z.number().int().positive() }),
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;