ALTER TABLE "Project" ADD COLUMN "activeDeploymentId" UUID, ADD COLUMN "maintenanceEnabled" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "maintenanceObserved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Deployment" ADD COLUMN "actorId" TEXT, ADD COLUMN "tokenId" TEXT, ADD COLUMN "previousReleaseId" UUID, ADD COLUMN "rollbackOfId" UUID, ADD COLUMN "sources" JSONB, ADD COLUMN "images" JSONB, ADD COLUMN "health" JSONB, ADD COLUMN "resolvedSpec" JSONB, ADD COLUMN "error" TEXT, ADD COLUMN "maintenancePolicy" TEXT NOT NULL DEFAULT 'never', ADD COLUMN "startedAt" TIMESTAMP(3), ADD COLUMN "finishedAt" TIMESTAMP(3), ADD COLUMN "activatedAt" TIMESTAMP(3);
CREATE INDEX "Deployment_projectId_createdAt_idx" ON "Deployment"("projectId","createdAt");
CREATE UNIQUE INDEX "Job_one_active_per_project" ON "Job"("projectId") WHERE status IN ('queued','running');
UPDATE "Project" p SET "activeDeploymentId" = d.id FROM (SELECT DISTINCT ON ("projectId") id,"projectId" FROM "Deployment" WHERE status='succeeded' ORDER BY "projectId","createdAt" DESC) d WHERE p.id=d."projectId";
UPDATE "Deployment" SET status='superseded' WHERE status='succeeded';
UPDATE "Deployment" d SET status='active',"activatedAt"=d."createdAt" FROM "Project" p WHERE p."activeDeploymentId"=d.id;

ALTER TABLE "Deployment" ADD COLUMN "encryptedSecrets" TEXT;
