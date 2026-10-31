// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';

vi.mock('@/lib/client', () => ({ api: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), clear: vi.fn() } }));
import { api } from '@/lib/client';
import { toast } from '@/lib/toast';
import { ApiError } from '@/lib/problem';
import { MessageTemplatesPanel } from '@/components/app/MessageTemplatesPanel';
import type { TemplateList } from '@/lib/message-templates';

const apiMock = vi.mocked(api) as unknown as ReturnType<typeof vi.fn>;
const BASE = '/api/business/message-templates';
const READY_DEFAULT = 'Good news from {business}: order {order} is ready. {next_step}';

const list = (over: Partial<TemplateList['items'][number]['channels'][number]> = {}): TemplateList => ({
  maxLength: 600, optOutReservedCharacters: 220,
  items: [{
    kind: 'order.ready', label: 'Order ready', description: 'Sent when an order becomes Ready.', defaultBody: READY_DEFAULT,
    placeholders: [{ name: 'business', description: 'Your business name' }, { name: 'order', description: 'The order number' }, { name: 'next_step', description: 'Next step' }],
    channels: [{ channel: 'SMS', customBody: null, usingDefault: true, updatedAtUtc: null, ...over }, { channel: 'WhatsApp', customBody: null, usingDefault: true, updatedAtUtc: null, fixed: true }],
  }],
});

beforeEach(() => { apiMock.mockReset(); vi.mocked(toast.success).mockReset(); });

describe('MessageTemplatesPanel', () => {
  it('shows a loading note, then the default wording for each channel', async () => {
    apiMock.mockResolvedValue(list());
    render(<MessageTemplatesPanel />);
    expect(screen.getByText('Loading message wording…')).toBeInTheDocument();
    const box = await screen.findByLabelText('Order ready message for SMS');
    expect(box).toHaveValue(READY_DEFAULT);
    expect(screen.getByText('Default wording')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(BASE);
    expect(screen.getByRole('button', { name: 'Save wording' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it('shows a failed load as an error and loads again on retry', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(500, 'Could not load the wording.'));
    apiMock.mockResolvedValueOnce(list());
    render(<MessageTemplatesPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the wording.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading messages' }));
    expect(await screen.findByLabelText('Order ready message for SMS')).toBeInTheDocument();
  });

  it('adds a placeholder to the text, saves the wording for the chosen channel only, and shows it as your wording', async () => {
    apiMock.mockResolvedValueOnce(list());
    render(<MessageTemplatesPanel />);
    const box = await screen.findByLabelText('Order ready message for SMS');
    fireEvent.change(box, { target: { value: 'Ready!' } });
    fireEvent.click(screen.getByRole('button', { name: '{order}' }));
    expect((box as HTMLTextAreaElement).value).toContain('{order}');
    const text = (box as HTMLTextAreaElement).value;
    apiMock.mockResolvedValueOnce({ kind: 'order.ready', channel: 'SMS', customBody: text, usingDefault: false, updatedAtUtc: '2026-10-30T12:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: 'Save wording' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(`${BASE}/order.ready/SMS`, { method: 'PUT', json: { body: text } }));
    expect(await screen.findByText('Your wording')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Order ready wording saved for SMS.');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));
    expect(screen.queryByLabelText('Order ready message for WhatsApp')).not.toBeInTheDocument();
    expect(screen.getByText('Set by Meta')).toBeInTheDocument();
  });

  it('shows the server\'s reasons when a wording is refused, and keeps what was typed', async () => {
    apiMock.mockResolvedValueOnce(list());
    render(<MessageTemplatesPanel />);
    const box = await screen.findByLabelText('Order ready message for SMS');
    fireEvent.change(box, { target: { value: 'Pay at https://x.example' } });
    apiMock.mockRejectedValueOnce(new ApiError(400, 'The message text is not valid.', 'validation_failed', { body: ['Links are not allowed in a message.'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save wording' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Links are not allowed in a message.');
    expect(box).toHaveValue('Pay at https://x.example');
  });

  it('previews with sample details and shows the length with the opt-out line', async () => {
    apiMock.mockResolvedValueOnce(list());
    render(<MessageTemplatesPanel />);
    await screen.findByLabelText('Order ready message for SMS');
    apiMock.mockResolvedValueOnce({ text: 'Good news from Taratara Atelier: order ORD-2026-0042 is ready. It is ready for collection.', characters: 92, charactersWithOptOut: 312 });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const preview = (await screen.findByText('Preview with sample details')).parentElement!;
    expect(within(preview).getByText(/ORD-2026-0042/)).toBeInTheDocument();
    expect(within(preview).getByText(/92 characters, about 312 with the opt-out line; roughly 3 text parts/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenLastCalledWith(`${BASE}/order.ready/preview`, { method: 'POST', json: { body: READY_DEFAULT } });
  });

  it('resets saved wording to the default', async () => {
    apiMock.mockResolvedValueOnce(list({ customBody: 'Mine {order}', usingDefault: false }));
    render(<MessageTemplatesPanel />);
    const box = await screen.findByLabelText('Order ready message for SMS');
    expect(box).toHaveValue('Mine {order}');
    expect(screen.getByText('Your wording')).toBeInTheDocument();
    apiMock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(apiMock).toHaveBeenLastCalledWith(`${BASE}/order.ready/SMS`, { method: 'DELETE' }));
    await waitFor(() => expect(box).toHaveValue(READY_DEFAULT));
    expect(screen.getByText('Default wording')).toBeInTheDocument();
  });

  it('step 16d: shows WhatsApp wording as fixed by Meta, with no editor and no save, preview or reset buttons', async () => {
    apiMock.mockResolvedValueOnce(list());
    render(<MessageTemplatesPanel />);
    await screen.findByLabelText('Order ready message for SMS');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));
    expect(screen.getByText(/approved by Meta/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Order ready message for WhatsApp')).not.toBeInTheDocument();
    for (const name of ['Save wording', 'Preview', 'Reset to default']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '{order}' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'SMS' }));
    expect(screen.getByLabelText('Order ready message for SMS')).toHaveValue(READY_DEFAULT);
    expect(screen.getByRole('button', { name: 'Save wording' })).toBeInTheDocument();
  });
});
