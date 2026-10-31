import {
  createFitting as createAppointmentFitting,
  listFittings as listAppointmentFittings,
  setFittingStatus as setAppointmentFittingStatus,
} from './appointmentService.js';

export function listFittings(db, user, filters, allowedLocations) {
  return listAppointmentFittings(db, user, filters, allowedLocations);
}

export function createFitting(pool, dbTransaction, user, payload, allowedLocations) {
  return createAppointmentFitting(pool, dbTransaction, user, payload, allowedLocations);
}

export function setFittingStatus(pool, dbTransaction, user, fittingId, payload, allowedLocations) {
  return setAppointmentFittingStatus(pool, dbTransaction, user, fittingId, payload, allowedLocations);
}