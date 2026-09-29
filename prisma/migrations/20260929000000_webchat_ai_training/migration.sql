-- CreateEnum
CREATE TYPE "WidgetPosition" AS ENUM ('BOTTOM_RIGHT', 'BOTTOM_LEFT');

-- CreateEnum
CREATE TYPE "PreChatMode" AS ENUM ('OFF', 'OPTIONAL', 'REQUIRED');

-- CreateEnum
CREATE TYPE "TrainingSource" AS ENUM ('MANUAL', 'INBOX', 'IMPORT');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "TrainingImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "Platform" ADD VALUE 'WEBCHAT';

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'WEBCHAT';

-- AlterEnum
ALTER TYPE "SocialAccountType" ADD VALUE 'WEBCHAT_WIDGET';

-- AlterTable
ALTER TABLE "AIAssistant" ALTER COLUMN "model" SET DEFAULT 'claude-opus-5-5';

-- AlterTable
ALTER TABLE "AIConversationSession" ADD COLUMN     "lastAnsweredMessageId" TEXT;

-- CreateTable
CREATE TABLE "AITrainingExample" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "questionHash" TEXT NOT NULL,
    "source" "TrainingSource" NOT NULL DEFAULT 'MANUAL',
    "status" "TrainingStatus" NOT NULL DEFAULT 'ACTIVE',
    "conversationId" TEXT,
    "messageId" TEXT,
    "createdById" TEXT,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AITrainingExample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AITrainingImport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "TrainingImportStatus" NOT NULL DEFAULT 'PENDING',
    "fileName" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "errors" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AITrainingImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatWidget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" "WidgetPosition" NOT NULL DEFAULT 'BOTTOM_RIGHT',
    "offsetX" INTEGER NOT NULL DEFAULT 20,
    "offsetY" INTEGER NOT NULL DEFAULT 20,
    "primaryColor" TEXT NOT NULL DEFAULT '#4f46e5',
    "logoUrl" TEXT,
    "launcherIcon" TEXT NOT NULL DEFAULT 'chat',
    "title" TEXT NOT NULL DEFAULT 'Chat with us',
    "subtitle" TEXT DEFAULT 'We typically reply in a few minutes',
    "welcomeMessage" TEXT DEFAULT 'Hi there! How can we help you today?',
    "inputPlaceholder" TEXT NOT NULL DEFAULT 'Type your message…',
    "offlineMessage" TEXT DEFAULT 'We''re away right now. Leave a message and we''ll get back to you.',
    "showBranding" BOOLEAN NOT NULL DEFAULT true,
    "preChatMode" "PreChatMode" NOT NULL DEFAULT 'OFF',
    "preChatFields" TEXT[] DEFAULT ARRAY['name', 'email']::TEXT[],
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenOrigin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatWidget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AITrainingExample_organizationId_status_idx" ON "AITrainingExample"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AITrainingExample_organizationId_updatedAt_idx" ON "AITrainingExample"("organizationId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AITrainingExample_organizationId_questionHash_key" ON "AITrainingExample"("organizationId", "questionHash");

-- CreateIndex
CREATE INDEX "AITrainingImport_organizationId_createdAt_idx" ON "AITrainingImport"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatWidget_socialAccountId_key" ON "ChatWidget"("socialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatWidget_publicKey_key" ON "ChatWidget"("publicKey");

-- CreateIndex
CREATE INDEX "ChatWidget_organizationId_idx" ON "ChatWidget"("organizationId");

-- AddForeignKey
ALTER TABLE "AITrainingExample" ADD CONSTRAINT "AITrainingExample_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AITrainingImport" ADD CONSTRAINT "AITrainingImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatWidget" ADD CONSTRAINT "ChatWidget_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatWidget" ADD CONSTRAINT "ChatWidget_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

