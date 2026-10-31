/** Small line icons for the Extras cards, keyed by the page they open. Decorative: the card's text names the page. */
const GLYPHS: Record<string, string> = {
  '/platform-admin/operations': 'M4 16a8 8 0 1116 0M12 16l4-5M12 16h.01',
  '/quick/measure': 'M3 16.5L16.5 3 21 7.5 7.5 21 3 16.5zM7 12.5l2 2M10 9.5l1.5 1.5M13 6.5l2 2',
  '/quick/package': 'M11 21.73a2 2 0 002 0l7-4A2 2 0 0021 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73zM12 22V12M3.29 7 12 12 20.71 7M7.5 4.27l9 5.15',
  '/quick/template': 'M9 4h6v3H9zM7 5.5H6a1 1 0 00-1 1V20a1 1 0 001 1h12a1 1 0 001-1V6.5a1 1 0 00-1-1h-1M9 12h6M9 16h6',
  '/dashboard': 'M4 11l8-7 8 7M6 10v10h12V10',
  '/customers': 'M9 11a3.2 3.2 0 100-6.4A3.2 3.2 0 009 11zM3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.2a3.2 3.2 0 010 6M18 14.8c1.8.7 3 2.4 3 5.2',
  '/orders': 'M7 4h10a2 2 0 012 2v13a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2zM9 4V3h6v1M9 10h6M9 14h6',
  '/fittings': 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  '/inquiries': 'M4 13l2.5-7h11L20 13M4 13v6h16v-6M4 13h4l1 2h6l1-2h4',
  '/tasks': 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  '/tasks/schedule': 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zM8 13h8M8 16.5h5',
  '/tasks/requests': 'M5 5h14a1 1 0 011 1v9a1 1 0 01-1 1H10l-4 3.5V16H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  '/workflows': 'M12 4l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
  '/workers/schedule': 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  '/finance': 'M4 7a2 2 0 012-2h12v4M4 7v11a2 2 0 002 2h14V9H6a2 2 0 01-2-2zM16 14.5h.01',
  '/inventory': 'M4 8l8-4 8 4v8l-8 4-8-4V8zM4 8l8 4 8-4M12 12v8',
  '/inventory/suppliers': 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 19.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  '/inventory/purchase-orders': 'M9 4h6v3H9zM7 5.5H6a1 1 0 00-1 1V20a1 1 0 001 1h12a1 1 0 001-1V6.5a1 1 0 00-1-1h-1M9 12h6M9 16h6',
  '/inventory/ready-to-wear': 'M8 4L3 7l2 4 3-1.5V20h8V9.5L19 11l2-4-5-3a4 4 0 01-8 0z',
  '/catalog': 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  '/ai-studio': 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z',
  '/reports': 'M5 20V10M12 20V4M19 20v-7',
  '/storefront': 'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9a2.7 2.7 0 005.3 0 2.7 2.7 0 005.4 0A2.7 2.7 0 0020 9M10 20v-5h4v5',
  '/staff': 'M9 11a3.2 3.2 0 100-6.4A3.2 3.2 0 009 11zM3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.2a3.2 3.2 0 010 6M18 14.8c1.8.7 3 2.4 3 5.2',
  '/audit': 'M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3zM8.5 12l2.5 2.5L16 9.5',
  '/settings': 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6',
  '/settings/billing': 'M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7zM3 10h18M7 15h3',
  '/account/security': 'M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z',
  '/account/data': 'M12 4v10M8 10l4 4 4-4M5 19h14',
  '/notifications': 'M6 16V11a6 6 0 1112 0v5l1.5 2h-15L6 16zM10 20a2 2 0 004 0',
  '/help': 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1-1.5 2M12 17h.01',
  '/customers/new': 'M9 11a3.2 3.2 0 100-6.4A3.2 3.2 0 009 11zM3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M19 8v6M16 11h6',
  '/orders/new': 'M12 5v14M5 12h14',
  '/finance/invoices/new': 'M7 3h7l4 4v14H7V3zM14 3v4h4M10 13h5M10 17h5',
};
const FALLBACK = 'M5 12h14M13 6l6 6-6 6';

export function NavGlyph({ href }: { href: string }) {
  return (
    <span className="ap-xicon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false"><path d={GLYPHS[href] ?? FALLBACK} /></svg>
    </span>
  );
}
