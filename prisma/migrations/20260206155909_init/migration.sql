-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

-- CreateTable
CREATE TABLE "CodOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT,
    "shopifyOrderName" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneConfirm" TEXT,
    "email" TEXT,
    "address" TEXT NOT NULL,
    "neighborhood" TEXT,
    "department" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "shipping" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "bundleSize" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DraftOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "shopifyDraftOrderId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "phone" TEXT NOT NULL,
    "items" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "convertedToOrderId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AlertConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailTo" TEXT,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappTo" TEXT,
    "checkIntervalMin" INTEGER NOT NULL DEFAULT 30,
    "noOrderThresholdMin" INTEGER NOT NULL DEFAULT 60,
    "activeHoursStart" TEXT NOT NULL DEFAULT '08:00',
    "activeHoursEnd" TEXT NOT NULL DEFAULT '22:00',
    "activeDays" TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "shopifyOrderId" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BundlePricing" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CodOrder_shopifyOrderId_key" ON "CodOrder"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "CodOrder_shop_idx" ON "CodOrder"("shop");

-- CreateIndex
CREATE INDEX "CodOrder_createdAt_idx" ON "CodOrder"("createdAt");

-- CreateIndex
CREATE INDEX "CodOrder_status_idx" ON "CodOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DraftOrder_shopifyDraftOrderId_key" ON "DraftOrder"("shopifyDraftOrderId");

-- CreateIndex
CREATE INDEX "DraftOrder_shop_idx" ON "DraftOrder"("shop");

-- CreateIndex
CREATE INDEX "DraftOrder_createdAt_idx" ON "DraftOrder"("createdAt");

-- CreateIndex
CREATE INDEX "DraftOrder_status_idx" ON "DraftOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AlertConfig_shop_key" ON "AlertConfig"("shop");

-- CreateIndex
CREATE INDEX "AlertLog_shop_idx" ON "AlertLog"("shop");

-- CreateIndex
CREATE INDEX "AlertLog_createdAt_idx" ON "AlertLog"("createdAt");

-- CreateIndex
CREATE INDEX "FormSubmission_shop_idx" ON "FormSubmission"("shop");

-- CreateIndex
CREATE INDEX "FormSubmission_createdAt_idx" ON "FormSubmission"("createdAt");

-- CreateIndex
CREATE INDEX "FormSubmission_type_idx" ON "FormSubmission"("type");

-- CreateIndex
CREATE INDEX "BundlePricing_shop_idx" ON "BundlePricing"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "BundlePricing_shop_quantity_key" ON "BundlePricing"("shop", "quantity");
