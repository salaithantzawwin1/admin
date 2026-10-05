-- ⏰ Delay (driver-reported ETA) notifications need their own bell type.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CAR_ETA_SET';
