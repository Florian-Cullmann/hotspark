CREATE TABLE "SystemTask" (
 "id" UUID NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "input" JSONB NOT NULL,
 "actorId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued', "attempts" INTEGER NOT NULL DEFAULT 0,
 "leaseUntil" TIMESTAMP(3), "workerId" TEXT, "result" JSONB, "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3)
);
CREATE INDEX "SystemTask_status_createdAt_idx" ON "SystemTask"("status", "createdAt");
CREATE TABLE "PlatformEvent" (
 "id" UUID NOT NULL PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, "type" TEXT NOT NULL,
 "resourceId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "deliveredAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "PlatformEvent_createdAt_idx" ON "PlatformEvent"("createdAt");

ALTER TABLE "Deployment" ADD COLUMN "buildDurationMs" INTEGER;
