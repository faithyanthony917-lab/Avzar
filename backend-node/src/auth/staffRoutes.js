import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import {
  AVAILABLE_PERMISSIONS, changeStaffStatus, createLocation, createRole, inviteStaff, listLocations, listRoles,
  listAudit, listStaff, setRolePermissions, setStaffLocations, setStaffRoles,
} from './adminService.js';

const inviteSchema = z.object({
  email: z.string().email().max(256),
  fullName: z.string().min(2).max(120),
  roleIds: z.array(z.string().uuid()).min(1),
  locationIds: z.array(z.string().uuid()).default([]),
});

const memberRoleSchema = z.object({ roleIds: z.array(z.string().uuid()).min(1) });
const memberLocationSchema = z.object({ locationIds: z.array(z.string().uuid()).default([]) });
const roleSchema = z.object({
  name: z.string().min(2).max(60),
  permissions: z.array(z.string()).default([]),
});
const locationSchema = z.object({
  name: z.string().min(2).max(120),
  address: z.string().max(500).nullish(),
});

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

function isUuid(value) { return z.string().uuid().safeParse(value).success; }

export function createStaffRouter({ env, pool }) {
  const router = Router();

  const requireStaffRead = [requireBearerAuth(env, pool), requirePermission('staff.view')];
  const requireStaffManage = [requireBearerAuth(env, pool), requirePermission('staff.manage')];
  const requireRolesManage = [requireBearerAuth(env, pool), requirePermission('roles.manage')];
  const requireLocationsManage = [requireBearerAuth(env, pool), requirePermission('locations.manage')];
  const requireAuditView = [requireBearerAuth(env, pool), requirePermission('audit.view')];

  router.get('/staff', ...requireStaffRead, async (req, res) => {
    if (!req.currentUser?.businessId) throw AppError.unauthorized('unauthorized', 'Authentication is required.');
    return res.status(200).json(await listStaff(pool, req.currentUser.businessId));
  });

  router.post('/staff/invitations', ...requireStaffManage, async (req, res) => {
    const payload = parse(inviteSchema, req.body);
    return res.status(201).json(await inviteStaff(pool, env, req.currentUser, payload));
  });

  router.post('/staff/:membershipId/deactivate', ...requireStaffManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The member ID is invalid.');
    await changeStaffStatus(pool, req.currentUser, req.params.membershipId, false);
    return res.status(204).end();
  });

  router.post('/staff/:membershipId/reactivate', ...requireStaffManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The member ID is invalid.');
    await changeStaffStatus(pool, req.currentUser, req.params.membershipId, true);
    return res.status(204).end();
  });

  router.put('/staff/:membershipId/roles', ...requireStaffManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The member ID is invalid.');
    const payload = parse(memberRoleSchema, req.body);
    await setStaffRoles(pool, req.currentUser, req.params.membershipId, payload.roleIds);
    return res.status(204).end();
  });

  router.put('/staff/:membershipId/locations', ...requireStaffManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The member ID is invalid.');
    const payload = parse(memberLocationSchema, req.body);
    await setStaffLocations(pool, req.currentUser, req.params.membershipId, payload.locationIds);
    return res.status(204).end();
  });

  router.get('/roles', ...requireStaffRead, async (req, res) =>
    res.status(200).json(await listRoles(pool, req.currentUser.businessId)));

  router.get('/roles/permissions', ...requireRolesManage, async (_req, res) => res.status(200).json(AVAILABLE_PERMISSIONS));

  router.post('/roles', ...requireRolesManage, async (req, res) => {
    const payload = parse(roleSchema, req.body);
    return res.status(201).json(await createRole(pool, req.currentUser, payload));
  });

  router.put('/roles/:roleId/permissions', ...requireRolesManage, async (req, res) => {
    if (!isUuid(req.params.roleId)) throw AppError.badRequest('invalid_role_id', 'The role ID is invalid.');
    const payload = parse(z.object({ permissions: z.array(z.string().trim().min(1).max(120)).default([]) }), req.body);
    return res.status(200).json(await setRolePermissions(pool, req.currentUser, req.params.roleId, payload.permissions));
  });

  router.get('/locations', ...requireStaffRead, async (req, res) =>
    res.status(200).json(await listLocations(pool, req.currentUser.businessId)));

  router.post('/locations', ...requireLocationsManage, async (req, res) => {
    const payload = parse(locationSchema, req.body);
    return res.status(201).json(await createLocation(pool, req.currentUser, payload));
  });

  router.get('/audit', ...requireAuditView, async (req, res) =>
    res.status(200).json(await listAudit(pool, req.currentUser.businessId, req.query)));

  return router;
}
