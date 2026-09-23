import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'sysadmin' })
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username!: string;

  @ApiProperty({ example: 'password' })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password!: string;
}
