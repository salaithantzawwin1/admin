-- CANCELLED notification type — requester/driver "cancelled" replies from Administration.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- supply lines closed by an admin/requester cancel (nothing was issued for them)
ALTER TYPE "SupplyLineStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
