import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RoleName } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnyPermission, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { OrgService, Actor } from './org.service';

class BranchDto {
  @IsString() @MinLength(2) @MaxLength(16) code!: string;
  @IsString() @MinLength(2) @MaxLength(128) name!: string;
  @IsOptional() @IsString() @MaxLength(255) address?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
}

class BranchUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(128) name?: string;
  @IsOptional() @IsString() @MaxLength(255) address?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class DepartmentDto {
  @IsString() @MinLength(2) @MaxLength(16) code!: string;
  @IsString() @MinLength(2) @MaxLength(128) name!: string;
  @IsOptional() @IsString() branchId?: string;
}

class DepartmentUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(128) name?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() headEmployeeId?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class EmployeeDto {
  @IsString() @MinLength(4) @MaxLength(32) employeeNo!: string;
  @IsString() @MinLength(2) @MaxLength(128) fullName!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(64) position?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() branchId?: string;
  // optional login account created together with the employee
  @IsOptional() @IsString() @MinLength(3) @MaxLength(32) username?: string;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(128) password?: string;
  @IsOptional() @IsArray() @IsIn(Object.values(RoleName), { each: true }) roles?: RoleName[];
  @IsOptional() @IsIn(['LOCAL', 'AD']) authSource?: 'LOCAL' | 'AD';
}

class EmployeeUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(128) fullName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(64) position?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
}

@ApiTags('org')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('org')
export class OrgController {
  constructor(private org: OrgService) {}

  private actor(req): Actor {
    return { userId: req.user.id, username: req.user.username };
  }

  // ----- read: org.read (branches/employees) or departments.read (department lists used by pickers) -----
  @Get('branches')
  @RequirePermissions(PERMISSIONS.ORG_READ)
  branches() {
    return this.org.listBranches();
  }

  @Get('departments')
  // OR: org.read (full org view) or the new departments.read (picker-only access)
  @AnyPermission([PERMISSIONS.ORG_READ], [PERMISSIONS.DEPARTMENTS_READ])
  departments() {
    return this.org.listDepartments();
  }

  @Get('employees')
  // OR: org.read (full org view) or the new employees.read (directory access)
  @AnyPermission([PERMISSIONS.ORG_READ], [PERMISSIONS.EMPLOYEES_READ])
  employees(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('departmentId') departmentId?: string) {
    return this.org.listEmployees(Number(page || 1), Math.min(100, Number(pageSize || 25)), departmentId);
  }

  // ----- write: SYSTEM_ADMIN or ADMINISTRATION -----
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @Post('branches')
  createBranch(@Req() req, @Body() dto: BranchDto) {
    return this.org.createBranch(dto, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @Patch('branches/:id')
  updateBranch(@Req() req, @Param('id') id: string, @Body() dto: BranchUpdateDto) {
    return this.org.updateBranch(id, dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.ORG_MANAGE], [PERMISSIONS.DEPARTMENTS_MANAGE])
  @Post('departments')
  createDepartment(@Req() req, @Body() dto: DepartmentDto) {
    return this.org.createDepartment(dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.ORG_MANAGE], [PERMISSIONS.DEPARTMENTS_MANAGE])
  @Patch('departments/:id')
  updateDepartment(@Req() req, @Param('id') id: string, @Body() dto: DepartmentUpdateDto) {
    return this.org.updateDepartment(id, dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.ORG_MANAGE], [PERMISSIONS.EMPLOYEES_MANAGE])
  @Post('employees')
  createEmployee(@Req() req, @Body() dto: EmployeeDto) {
    return this.org.createEmployee(dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.ORG_MANAGE], [PERMISSIONS.EMPLOYEES_MANAGE])
  @Patch('employees/:id')
  updateEmployee(@Req() req, @Param('id') id: string, @Body() dto: EmployeeUpdateDto) {
    return this.org.updateEmployee(id, dto, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.ORG_MANAGE], [PERMISSIONS.EMPLOYEES_MANAGE])
  @Post('employees/:id/login')
  linkLogin(@Req() req, @Param('id') id: string, @Body() dto: { userId?: string; username?: string; password?: string; roles?: RoleName[]; authSource?: 'LOCAL' | 'AD' }) {
    return this.org.linkLogin(id, dto, this.actor(req));
  }

  /** Remove the employee ↔ user link (the account itself is kept on the Users page). */
  @AnyPermission([PERMISSIONS.ORG_MANAGE], [PERMISSIONS.EMPLOYEES_MANAGE])
  @Delete('employees/:id/login')
  unlinkLogin(@Req() req, @Param('id') id: string) {
    return this.org.unlinkLogin(id, this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @Get('employees/:id/roles')
  employeeRoles(@Param('id') id: string) {
    return this.org.employeeRoles(id);
  }

  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @Patch('employees/:id/roles')
  setEmployeeRoles(@Req() req, @Param('id') id: string, @Body() dto: { roles: RoleName[] }) {
    return this.org.setEmployeeRoles(id, dto.roles ?? [], this.actor(req));
  }

  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @Delete('branches/:id')
  deleteBranch(@Req() req, @Param('id') id: string) {
    return this.org.deleteBranch(id, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.ORG_MANAGE], [PERMISSIONS.DEPARTMENTS_MANAGE])
  @Delete('departments/:id')
  deleteDepartment(@Req() req, @Param('id') id: string) {
    return this.org.deleteDepartment(id, this.actor(req));
  }

  @AnyPermission([PERMISSIONS.ORG_MANAGE], [PERMISSIONS.EMPLOYEES_MANAGE])
  @Delete('employees/:id')
  deleteEmployee(@Req() req, @Param('id') id: string) {
    return this.org.deleteEmployee(id, this.actor(req));
  }
}
