-- AMS Phase 2 — workflow engine, delegations, notifications, attachments, numbering

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'ON_HOLD', 'IN_PROGRESS', 'COMPLETED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('SUBMIT', 'APPROVE', 'REJECT', 'RETURN', 'FINAL_APPROVE');

-- CreateEnum
CREATE TYPE "DelegationStatus" AS ENUM ('ACTIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'FINAL_APPROVED', 'DELEGATED', 'ESCALATED', 'REMINDER');

-- CreateEnum
CREATE TYPE "NotificationReadStatus" AS ENUM ('UNREAD', 'READ');

-- CreateEnum
CREATE TYPE "RequestDocType" AS ENUM ('GENERIC_REQUEST', 'CAR_REQUEST', 'MEETING_ROOM_REQUEST', 'PURCHASE_REQUEST', 'OFFICE_SUPPLY_REQUEST', 'TRAVEL_REQUEST', 'MAINTENANCE_REQUEST');

-- CreateTable
CREATE TABLE "approval_workflows" (
    "id" UUID NOT NULL,
    "module" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "roleName" "RoleName" NOT NULL,
    "minApprovals" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_documents" (
    "id" UUID NOT NULL,
    "docNumber" TEXT NOT NULL,
    "docType" "RequestDocType" NOT NULL DEFAULT 'GENERIC_REQUEST',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "requesterId" UUID NOT NULL,
    "departmentId" UUID,
    "currentLevel" INTEGER NOT NULL DEFAULT 0,
    "totalLevels" INTEGER NOT NULL DEFAULT 0,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "request_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_actions" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "approverId" UUID NOT NULL,
    "action" "ApprovalActionType" NOT NULL,
    "comment" TEXT,
    "previousStatus" "WorkflowStatus" NOT NULL,
    "newStatus" "WorkflowStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_delegations" (
    "id" UUID NOT NULL,
    "fromUserId" UUID NOT NULL,
    "toUserId" UUID NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "DelegationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "requestId" TEXT,
    "readStatus" "NotificationReadStatus" NOT NULL DEFAULT 'UNREAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "requestId" UUID,
    "filename" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_workflows_module_key" ON "approval_workflows"("module");
CREATE UNIQUE INDEX "request_documents_docNumber_key" ON "request_documents"("docNumber");
CREATE UNIQUE INDEX "attachments_storedName_key" ON "attachments"("storedName");
CREATE UNIQUE INDEX "document_sequences_key_key" ON "document_sequences"("key");
CREATE INDEX "approval_steps_workflowId_level_key" ON "approval_steps"("workflowId", "level");
CREATE INDEX "request_documents_status_idx" ON "request_documents"("status");
CREATE INDEX "request_documents_requesterId_idx" ON "request_documents"("requesterId");
CREATE INDEX "approval_actions_requestId_idx" ON "approval_actions"("requestId");
CREATE INDEX "approval_delegations_fromUserId_status_idx" ON "approval_delegations"("fromUserId", "status");
CREATE INDEX "approval_delegations_toUserId_status_idx" ON "approval_delegations"("toUserId", "status");
CREATE INDEX "notifications_userId_readStatus_idx" ON "notifications"("userId", "readStatus");
CREATE INDEX "attachments_requestId_idx" ON "attachments"("requestId");

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "approval_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_documents" ADD CONSTRAINT "request_documents_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "request_documents" ADD CONSTRAINT "request_documents_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "request_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
