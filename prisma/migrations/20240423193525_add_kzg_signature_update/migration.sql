-- AlterTable
ALTER TABLE "Ballot" ALTER COLUMN "kzgCommitment" DROP NOT NULL,
ALTER COLUMN "kzgSignature" DROP NOT NULL;
