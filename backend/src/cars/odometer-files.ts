import * as path from 'path';

/**
 * The dashboard photos of the car-trip flow, and how long they are trusted.
 *
 * One place for the names and the lifetime, because three pieces of the flow
 * share them: the Telegram bot arms a capture and resumes it after a restart
 * (how long a persisted capture is worth resuming), the janitor reclaims files
 * no row names (the same lifetime), and they must agree — a loader that trusts
 * a capture the janitor has deleted asks the driver for a photo that is gone.
 */

/** Folder under UPLOAD_PATH: saved readings (startOdoPhoto / endOdoPhoto). */
export const ODO_DIR = 'odometer';

/** Sub-folder of ODO_DIR: a capture waiting for the driver's number. */
export const ODO_PENDING_DIR = 'pending';

/** A capture nobody finished, and a photo no row names, are orphan after a day. */
export const ODO_FILE_TTL_MS = 24 * 3600 * 1000;

/** Only names this service writes: a uuid plus an image extension. */
export const ODO_FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

/** Absolute path of a folder (or file) under the odometer tree. */
export function odoPath(...segments: string[]): string {
  return path.join(process.env.UPLOAD_PATH || '/app/uploads', ODO_DIR, ...segments);
}
