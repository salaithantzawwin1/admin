import { BadRequestException } from '@nestjs/common';

/**
 * One password rule for every way an account can get a password: the Users
 * page, an employee login, an administration reset and a self-service change.
 * Weak passwords here protect nothing — every account can read a register,
 * approve spending or move a vehicle.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULE = `at least ${PASSWORD_MIN_LENGTH} characters with a letter and a number`;

/** Throws 400 with an actionable message when the password is too weak. */
export function assertStrongPassword(password: string | undefined | null): void {
  const value = password ?? '';
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new BadRequestException(`Password must be ${PASSWORD_RULE}`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw new BadRequestException(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    throw new BadRequestException(`Password must be ${PASSWORD_RULE}`);
  }
  if (/^\s|\s$/.test(value)) {
    throw new BadRequestException('Password must not start or end with a space');
  }
}
