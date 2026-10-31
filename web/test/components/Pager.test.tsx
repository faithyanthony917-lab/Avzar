// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../support/dom';

import { Pager, usePaged } from '@/components/app/Pager';

function Demo({ count }: { count: number }) {
  const paged = usePaged(Array.from({ length: count }, (_, i) => `row-${i + 1}`), 10);
  return <div>
    <ul>{paged.slice.map((r) => <li key={r}>{r}</li>)}</ul>
    <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} />
  </div>;
}

describe('Pager', () => {
  it('shows no controls when everything fits on one page', () => {
    render(<Demo count={10} />);
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });

  it('pages through a longer list with Previous and Next', () => {
    render(<Demo count={25} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('Showing 1–10 of 25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('row-11')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
