CREATE TABLE "ShopScheduleVersions" (
  "Id" uuid NOT NULL,
  "BusinessId" uuid NOT NULL,
  "VersionNumber" integer NOT NULL,
  "StartUtc" timestamp with time zone NOT NULL,
  "HorizonDays" integer NOT NULL,
  "TimeZoneId" character varying(100) NOT NULL,
  "TaskCount" integer NOT NULL,
  "SlotsJson" jsonb NOT NULL,
  "PublishedByUserId" uuid NOT NULL,
  "PublishedAtUtc" timestamp with time zone NOT NULL,
  CONSTRAINT "PK_ShopScheduleVersions" PRIMARY KEY ("Id"),
  CONSTRAINT "AK_ShopScheduleVersions_Business_Version" UNIQUE ("BusinessId", "VersionNumber"),
  CONSTRAINT "CK_ShopScheduleVersions_VersionNumber" CHECK ("VersionNumber" > 0),
  CONSTRAINT "CK_ShopScheduleVersions_HorizonDays" CHECK ("HorizonDays" BETWEEN 1 AND 366),
  CONSTRAINT "CK_ShopScheduleVersions_TaskCount" CHECK ("TaskCount" > 0),
  CONSTRAINT "CK_ShopScheduleVersions_SlotsJson" CHECK (jsonb_typeof("SlotsJson") = 'array'),
  CONSTRAINT "FK_ShopScheduleVersions_Businesses_BusinessId" FOREIGN KEY ("BusinessId") REFERENCES "Businesses" ("Id") ON DELETE RESTRICT,
  CONSTRAINT "FK_ShopScheduleVersions_AspNetUsers_PublishedByUserId" FOREIGN KEY ("PublishedByUserId") REFERENCES "AspNetUsers" ("Id") ON DELETE RESTRICT
);
CREATE INDEX "IX_ShopScheduleVersions_Business_PublishedAtUtc"
  ON "ShopScheduleVersions" ("BusinessId", "PublishedAtUtc" DESC, "VersionNumber" DESC);