import { z } from 'zod';
import { ciEnum } from '../http/ciEnum.js';

// The calculator input, shared by POST /pricing/calculate and the order garment `pricing` field.
export const pricingInputSchema = z.object({
  materials: z.array(z.object({ name: z.string().min(1).max(80), quantity: z.number().min(0).max(1_000_000), unitCost: z.number().min(0).max(1_000_000_000) })).max(50).default([]),
  labour: z.array(z.object({ task: z.string().min(1).max(80), hours: z.number().min(0).max(1000), hourlyRate: z.number().min(0).max(1_000_000).nullish() })).max(30).default([]),
  other: z.array(z.object({ name: z.string().min(1).max(80), amount: z.number().min(0).max(1_000_000_000) })).max(30).default([]),
  complexityMultiplier: z.number().min(0.5).max(5).default(1),
  method: ciEnum(['Markup', 'Margin']).nullish(),
  targetPercent: z.number().min(0).max(1000).nullish(),
});
