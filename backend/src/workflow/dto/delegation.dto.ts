import { IsBoolean, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateDelegationDto {
  @IsString() toUserId!: string;

  @IsISO8601() startAt!: string;

  @IsISO8601() endAt!: string;

  @IsOptional() @IsString() @MaxLength(500) reason?: string;

  /** true only when the user confirmed an overlapping-period warning ("Save anyway"). */
  @IsOptional() @IsBoolean() overrideOverlap?: boolean;
}
