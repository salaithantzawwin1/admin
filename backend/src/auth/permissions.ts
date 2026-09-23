// RBAC fine-grained permission catalog (Plan §4/§5).
// Codes must match backend/prisma/migrations/*_rbac_permissions/migration.sql seeds.
export const PERMISSIONS = {
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  ORG_READ: 'org.read',
  ORG_MANAGE: 'org.manage',
  REQUESTS_READ_OWN: 'requests.read.own',
  REQUESTS_READ_ALL: 'requests.read.all',
  REQUESTS_CREATE: 'requests.create',
  APPROVALS_ACT: 'approvals.act',
  WORKFLOW_MANAGE: 'workflow.manage',
  FLEET_READ: 'fleet.read',
  FLEET_MANAGE: 'fleet.manage',
  CARS_ASSIGN: 'cars.assign',
  MEETING_ROOMS_ASSIGN: 'meeting-rooms.assign',
  FLEET_TYPES_MANAGE: 'fleet.types.manage',
  MEETING_ROOMS_FACILITIES_MANAGE: 'meeting-rooms.facilities.manage',
  INVENTORY_READ: 'inventory.read',
  INVENTORY_MANAGE: 'inventory.manage',
  ANNOUNCEMENTS_READ: 'announcements.read',
  ANNOUNCEMENTS_MANAGE: 'announcements.manage',
  AUDIT_READ: 'audit.read',
  ATTACHMENTS_USE: 'attachments.use',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSION_CODES: PermissionCode[] = Object.values(PERMISSIONS);
