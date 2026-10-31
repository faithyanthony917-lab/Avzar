CREATE TABLE "TaskProgressPhotos" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "TaskId" uuid NOT NULL,
  "MediaAssetId" uuid NOT NULL,
  "UploadedByMembershipId" uuid NOT NULL,
  "Caption" character varying(500),
  "UploadedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_TaskProgressPhotos" PRIMARY KEY ("Id"),
  CONSTRAINT "FK_TaskProgressPhotos_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_TaskProgressPhotos_ProductionTasks_TaskId_BusinessId" FOREIGN KEY ("TaskId", "BusinessId") REFERENCES "ProductionTasks" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_TaskProgressPhotos_MediaAssets_MediaAssetId_BusinessId" FOREIGN KEY ("MediaAssetId", "BusinessId") REFERENCES "MediaAssets" ("Id", "BusinessId") ON DELETE RESTRICT,
  CONSTRAINT "FK_TaskProgressPhotos_Memberships_UploadedByMembershipId_BusinessId" FOREIGN KEY ("UploadedByMembershipId", "BusinessId") REFERENCES "Memberships" ("Id", "BusinessId") ON DELETE RESTRICT
);
CREATE INDEX "IX_TaskProgressPhotos_BusinessId_TaskId_UploadedAtUtc" ON "TaskProgressPhotos" ("BusinessId", "TaskId", "UploadedAtUtc" DESC);
CREATE INDEX "IX_TaskProgressPhotos_MediaAssetId" ON "TaskProgressPhotos" ("MediaAssetId");
