-- CreateTable: NoteAsset (content-hash cache for note PDFs in Cloudinary/Supabase)
-- Additive only — no existing tables are modified or dropped.

-- CreateTable
CREATE TABLE "NoteAsset" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "bytes" INTEGER,
    "version" TEXT,
    "hash" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NoteAsset_folder_idx" ON "NoteAsset"("folder");

-- CreateIndex
CREATE UNIQUE INDEX "NoteAsset_provider_publicId_key" ON "NoteAsset"("provider", "publicId");
