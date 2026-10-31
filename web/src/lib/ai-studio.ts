export type FashionDesignInput = {
  garmentType: string;
  occasion: string;
  style: string;
  fabric: string;
  colours: string;
  details?: string;
};

export type AssistantDraftInput = {
  businessType: string;
  audience: string;
  brandStyle: string;
  goals: string;
  existingContent?: string;
};

/** Trim and validate AI prompts before sending them to a paid provider. */
export function normalizeFashionDesignInput(input: FashionDesignInput): FashionDesignInput {
  const required = [input.garmentType, input.occasion, input.style, input.fabric, input.colours];
  if (required.some((value) => !value.trim())) throw new Error('Complete garment, occasion, style, fabric and colours first.');
  for (const value of [...required, input.details ?? '']) {
    if (value.length > 2000) throw new Error('AI design fields must be 2,000 characters or fewer.');
  }
  return {
    garmentType: input.garmentType.trim(), occasion: input.occasion.trim(), style: input.style.trim(),
    fabric: input.fabric.trim(), colours: input.colours.trim(), details: input.details?.trim() || 'No extra details',
  };
}

export function normalizeAssistantDraftInput(input: AssistantDraftInput): AssistantDraftInput {
  const required = [input.businessType, input.audience, input.brandStyle, input.goals];
  if (required.some((value) => !value.trim())) throw new Error('Complete business type, audience, brand voice and goals first.');
  if ([...required, input.existingContent ?? ''].some((value) => value.length > 2000)) {
    throw new Error('Assistant builder fields must be 2,000 characters or fewer.');
  }
  return {
    businessType: input.businessType.trim(), audience: input.audience.trim(), brandStyle: input.brandStyle.trim(),
    goals: input.goals.trim(), existingContent: input.existingContent?.trim() || 'No existing content',
  };
}
