-- AlterTable
ALTER TABLE "bundles" ADD COLUMN     "urgent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "urgentMarkedAt" TIMESTAMP(3),
ADD COLUMN     "urgentMarkedBy" TEXT,
ADD COLUMN     "urgentNote" TEXT,
ADD COLUMN     "urgentReason" TEXT;
