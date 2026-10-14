-- AlterTable: change alertChatId from BIGINT to VARCHAR(100) to support both numeric chat IDs and @channel usernames
ALTER TABLE "PlatformSettings" ALTER COLUMN "alertChatId" TYPE VARCHAR(100) USING "alertChatId"::VARCHAR(100);
