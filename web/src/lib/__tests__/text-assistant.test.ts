import { describe, expect, it } from 'vitest';
import { normalizeTextAssistantRequest } from '../text-assistant';

describe('text assistant request', () => {
  it('trims inputs and keeps only the latest eight messages', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: ` message ${i} ` }));
    const result = normalizeTextAssistantRequest({ question: '  Help with production  ', businessType: ' Tailor ', context: ' Three workers ', history });
    expect(result.question).toBe('Help with production');
    expect(result.businessType).toBe('Tailor');
    expect(result.context).toBe('Three workers');
    expect(result.history).toHaveLength(8);
    expect(result.history[0]?.content).toBe('message 2');
  });
  it('rejects blank questions and oversized context', () => {
    expect(() => normalizeTextAssistantRequest({ question: '  ' })).toThrow();
    expect(() => normalizeTextAssistantRequest({ question: 'Help', context: 'x'.repeat(4001) })).toThrow();
  });
});

import { normalizeStructuredTextDraftRequest } from '../text-assistant';

describe('structured text draft request', () => {
  it('trims the context and applies safe defaults', () => {
    expect(normalizeStructuredTextDraftRequest({ type: 'product_description', context: '  Handmade linen shirt  ' })).toEqual({
      type: 'product_description', businessType: 'Fashion business', audience: '', tone: 'Warm and professional', context: 'Handmade linen shirt',
    });
  });
  it('rejects blank or oversized context and oversized metadata', () => {
    expect(() => normalizeStructuredTextDraftRequest({ type: 'report_explanation', context: '  ' })).toThrow();
    expect(() => normalizeStructuredTextDraftRequest({ type: 'report_explanation', context: 'x'.repeat(6001) })).toThrow();
    expect(() => normalizeStructuredTextDraftRequest({ type: 'customer_reply', context: 'Message', audience: 'x'.repeat(201) })).toThrow();
  });
});
