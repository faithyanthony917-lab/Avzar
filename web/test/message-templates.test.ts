import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/problem';
import { insertPlaceholder, smsParts, templateErrorText } from '@/lib/message-templates';

describe('insertPlaceholder', () => {
  it('puts the placeholder at the cursor and moves the cursor after it', () => {
    expect(insertPlaceholder('Hi , welcome', 'business', 3, 3)).toEqual({ text: 'Hi {business}, welcome', cursor: 13 });
  });
  it('replaces a selection, goes to the end with no cursor and clamps a cursor that is out of range', () => {
    expect(insertPlaceholder('Order XXX ready', 'order', 6, 9)).toEqual({ text: 'Order {order} ready', cursor: 13 });
    expect(insertPlaceholder('Hi ', 'business')).toEqual({ text: 'Hi {business}', cursor: 13 });
    expect(insertPlaceholder('Hi', 'order', 99, 120)).toEqual({ text: 'Hi{order}', cursor: 9 });
  });
});

describe('smsParts', () => {
  it('counts one part up to 160 plain characters, then 153 per part', () => {
    expect(smsParts('a'.repeat(160), 160)).toBe(1);
    expect(smsParts('a'.repeat(161), 161)).toBe(2);
    expect(smsParts('a'.repeat(306), 306)).toBe(2);
    expect(smsParts('a'.repeat(307), 307)).toBe(3);
    expect(smsParts('', 0)).toBe(0);
  });
  it('counts a message with a character outside the basic alphabet as Unicode: 70, then 67 per part', () => {
    expect(smsParts('Ọ'.repeat(70), 70)).toBe(1);
    expect(smsParts('Ọ'.repeat(71), 71)).toBe(2);
  });
});

describe('templateErrorText', () => {
  it('shows the server\'s reasons for the message text when there are any, else the error message, else the fallback', () => {
    expect(templateErrorText(new ApiError(400, 'The message text is not valid.', 'validation_failed', { body: ['Links are not allowed.', 'Remove the < character.'] }), 'x')).toBe('Links are not allowed. Remove the < character.');
    expect(templateErrorText(new ApiError(500, 'Server trouble.'), 'x')).toBe('Server trouble.');
    expect(templateErrorText(new Error('network'), 'Could not reach the server.')).toBe('Could not reach the server.');
  });
});
