// The single source of truth for order statuses and the moves between them.
//
// This table records what the code already did before it was written down; it does not add new moves.
// Routes still decide WHEN a move happens (for example, a task-driven move to Ready); this module only says
// whether a move is allowed and which statuses belong to which group, so no route keeps its own list.

export const ORDER_STATUSES = Object.freeze(
  ['Draft', 'Quoted', 'Confirmed', 'InProduction', 'Ready', 'Delivered', 'Cancelled'],
);

const TRANSITIONS = Object.freeze({
  Draft: Object.freeze(['Quoted', 'Cancelled']),
  // Quoted goes back to Draft when the order is edited (the quotation must be issued again).
  Quoted: Object.freeze(['Draft', 'Confirmed', 'Cancelled']),
  // Confirmed can go straight to Ready when every task is finished before any is seen as started.
  Confirmed: Object.freeze(['InProduction', 'Ready', 'Cancelled']),
  InProduction: Object.freeze(['Ready', 'Cancelled']),
  // Ready goes back to InProduction when a task is reopened or added.
  Ready: Object.freeze(['InProduction', 'Delivered', 'Cancelled']),
  Delivered: Object.freeze([]),
  Cancelled: Object.freeze([]),
});

// Draft and Quoted orders can be edited in place.
export const EDITABLE = Object.freeze(['Draft', 'Quoted']);
// Tasks can be generated and worked on.
export const PRODUCTION_ACTIVE = Object.freeze(['Confirmed', 'InProduction']);
// Production is not finished: tasks can be added, overridden or sent back for alterations.
export const PRODUCTION_OPEN = Object.freeze(['Confirmed', 'InProduction', 'Ready']);
// An invoice can be raised.
export const INVOICEABLE = Object.freeze(['Confirmed', 'InProduction', 'Ready', 'Delivered']);

export function isOrderStatus(value) {
  return ORDER_STATUSES.includes(value);
}

export function allowedNextStatuses(from) {
  return [...(TRANSITIONS[from] ?? [])];
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isEditable(status) {
  return EDITABLE.includes(status);
}

export function isProductionActive(status) {
  return PRODUCTION_ACTIVE.includes(status);
}

export function isProductionOpen(status) {
  return PRODUCTION_OPEN.includes(status);
}

export function isInvoiceable(status) {
  return INVOICEABLE.includes(status);
}

// For SQL text only: builds 'A', 'B' from a fixed group above. Refuses anything that is not a known status,
// so request data can never reach it.
export function sqlStatusList(group) {
  for (const status of group) {
    if (!isOrderStatus(status)) throw new Error(`Unknown order status: ${status}`);
  }
  return group.map((status) => `'${status}'`).join(', ');
}
