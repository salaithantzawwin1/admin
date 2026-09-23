import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateDelegationDto {
  @IsString() toUserId!: string;

  @IsISO8601() startAt!: string;

  @IsISO8601() endAt!: string;

  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
