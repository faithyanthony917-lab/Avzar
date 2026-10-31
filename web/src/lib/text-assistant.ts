export type TextAssistantMessage = { role: 'user' | 'assistant'; content: string };

export function normalizeTextAssistantRequest(input: {
  question: string;
  businessType?: string;
  context?: string;
  history?: TextAssistantMessage[];
}) {
  const question = input.question.trim();
  const businessType = (input.businessType ?? 'Fashion business').trim() || 'Fashion business';
  const context = (input.context ?? '').trim();
  const history = (input.history ?? []).slice(-8).map((message) => ({
    role: message.role,
    content: message.content.trim(),
  }));
  if (!question || question.length > 4000) throw new Error('Enter a question of 1–4,000 characters.');
  if (businessType.length > 200 || context.length > 4000) throw new Error('Business type or context is too long.');
  if (history.some((message) => !message.content || message.content.length > 2000)) throw new Error('Conversation history contains an invalid message.');
  return { question, businessType, context, history };
}

export type StructuredTextDraftType =
  | 'product_description'
  | 'collection_names'
  | 'customer_reply'
  | 'report_explanation'
  | 'scheduling_risk';

export function normalizeStructuredTextDraftRequest(input: {
  type: StructuredTextDraftType;
  businessType?: string;
  audience?: string;
  tone?: string;
  context: string;
}) {
  const context = input.context.trim();
  const businessType = (input.businessType ?? 'Fashion business').trim() || 'Fashion business';
  const audience = (input.audience ?? '').trim();
  const tone = (input.tone ?? 'Warm and professional').trim() || 'Warm and professional';
  if (!context || context.length > 6000) throw new Error('Enter context of 1–6,000 characters.');
  if (businessType.length > 200 || audience.length > 200 || tone.length > 100) throw new Error('Business type, audience, or tone is too long.');
  return { type: input.type, businessType, audience, tone, context };
}
