-- DropIndex
DROP INDEX IF EXISTS "Bot_adminInviteCode_key";

-- AlterTable
ALTER TABLE "Bot" DROP COLUMN IF EXISTS "adminInviteCode";
