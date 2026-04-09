/*
  Warnings:

  - You are about to drop the column `faxNumber` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `licenseNumber` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `licenseState` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `logoUrl` on the `drivers` table. All the data in the column will be lost.
  - You are about to drop the column `website` on the `drivers` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "drivers" DROP COLUMN "faxNumber",
DROP COLUMN "licenseNumber",
DROP COLUMN "licenseState",
DROP COLUMN "logoUrl",
DROP COLUMN "website";

-- AlterTable
ALTER TABLE "pharmacies" ADD COLUMN     "faxNumber" TEXT,
ADD COLUMN     "licenseNumber" TEXT,
ADD COLUMN     "licenseState" TEXT,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "website" TEXT;
