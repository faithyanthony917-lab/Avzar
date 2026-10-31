import { describe, expect, it } from 'vitest';
import { normalizeAssistantDraftInput, normalizeFashionDesignInput } from '../ai-studio';

describe('AI Studio input normalization', () => {
  it('trims fashion design fields and supplies a safe default for optional details', () => {
    expect(normalizeFashionDesignInput({ garmentType: ' Agbada ', occasion: ' Wedding ', style: ' Modern ', fabric: ' Aso-oke ', colours: ' Ivory ', details: ' ' }))
      .toEqual({ garmentType: 'Agbada', occasion: 'Wedding', style: 'Modern', fabric: 'Aso-oke', colours: 'Ivory', details: 'No extra details' });
  });
  it('rejects a missing required design field', () => {
    expect(() => normalizeFashionDesignInput({ garmentType: '', occasion: 'Wedding', style: 'Modern', fabric: 'Cotton', colours: 'Blue' })).toThrow();
  });
  it('rejects overlong design details', () => {
    expect(() => normalizeFashionDesignInput({ garmentType: 'Agbada', occasion: 'Wedding', style: 'Modern', fabric: 'Cotton', colours: 'Blue', details: 'x'.repeat(2001) })).toThrow();
  });
  it('trims assistant fields and uses a default for empty existing content', () => {
    expect(normalizeAssistantDraftInput({ businessType: ' Tailor ', audience: ' Adults ', brandStyle: ' Warm ', goals: ' Answer FAQs ', existingContent: ' ' }))
      .toEqual({ businessType: 'Tailor', audience: 'Adults', brandStyle: 'Warm', goals: 'Answer FAQs', existingContent: 'No existing content' });
  });
  it('rejects blank assistant goals', () => {
    expect(() => normalizeAssistantDraftInput({ businessType: 'Tailor', audience: 'Adults', brandStyle: 'Warm', goals: '  ' })).toThrow();
  });
});
