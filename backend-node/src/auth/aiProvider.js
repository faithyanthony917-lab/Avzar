import { AppError } from '../http/errors.js';

const TIMEOUT_MS = 90_000;

/**
 * AI provider interface (OpenAI today). Tests inject a fake with the same shape:
 *   isConfigured(): boolean
 *   imageModel: string
 *   generateImage(prompt): Promise<{ base64Png }>
 *   completeText(prompt): Promise<string>
 */
export function createAiProvider(env) {
  const key = env.AI_OPENAI_API_KEY?.trim() || '';
  const imageModel = env.AI_OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
  const textModel = env.AI_OPENAI_TEXT_MODEL ?? 'gpt-4.1-mini';

  async function post(path, payload, label) {
    let response;
    try {
      response = await fetch('https://api.openai.com/v1' + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AppError(502, 'ai_provider_error', `The ${label} provider could not complete this request. Try again later.`);
    }
    if (!response.ok) throw new AppError(502, 'ai_provider_error', `The ${label} provider could not complete this request. Try again later.`);
    try { return await response.json(); }
    catch { throw new AppError(502, 'ai_provider_response_invalid', `The ${label} provider returned an unsupported response.`); }
  }

  return {
    isConfigured: () => key.length > 0,
    imageModel,
    textModel,
    async generateImage(prompt) {
      const json = await post('/images/generations', { model: imageModel, prompt, size: '1024x1024', n: 1, output_format: 'png' }, 'image');
      const b64 = json?.data?.[0]?.b64_json;
      if (typeof b64 !== 'string' || !b64) throw new AppError(502, 'ai_provider_response_invalid', 'The image provider returned an unsupported response.');
      return { base64Png: b64 };
    },
    async completeText(prompt, systemPrompt = 'Follow the requested schema exactly. Do not include markdown fences.') {
      const json = await post('/chat/completions', {
        model: textModel,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }, 'AI');
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AppError(502, 'ai_provider_response_invalid', 'The AI provider returned an unsupported assistant configuration.');
      return content;
    },
  };
}
