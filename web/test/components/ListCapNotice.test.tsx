// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../support/dom';
import { ListCapNotice } from '@/components/app/ListCapNotice';

describe('ListCapNotice', () => {
  it('says how much of the list is shown when it was cut', () => {
    render(<ListCapNotice shown={1000} total={1350} hint="Export the list as CSV to see everything." />);
    expect(screen.getByRole('status').textContent).toBe('Showing the first 1,000 of 1,350. Export the list as CSV to see everything.');
  });
  it('shows nothing when the whole list is shown', () => {
    const { container } = render(<ListCapNotice shown={20} total={20} />);
    expect(container.textContent).toBe('');
    render(<ListCapNotice shown={20} total={0} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
