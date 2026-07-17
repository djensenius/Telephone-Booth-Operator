export type FakeBlobHead = {
  exists: boolean;
  sizeBytes: number;
  contentType: string | null;
  sha256: string | null;
};

export const fakeBlobs = new Map<string, FakeBlobHead>();
// Actual blob bytes, keyed by blob name. Populated by uploadBlob (and by
// tests via seedBlobData) so downloadBlob round-trips for export/import tests.
export const fakeBlobData = new Map<string, Buffer>();

export const seedBlobData = (blobName: string, data: Buffer, sha256?: string): void => {
  fakeBlobData.set(blobName, data);
  fakeBlobs.set(blobName, {
    exists: true,
    sizeBytes: data.byteLength,
    contentType: "audio/mp4",
    sha256: sha256 ?? null,
  });
};

export const resetFakeAzure = (): void => {
  fakeBlobs.clear();
  fakeBlobData.clear();
};

export const fakeAzureModule = {
  generateSasUrl: (blobName: string, options: { permissions: "r" | "cw"; expiresOn?: Date }) => {
    const expiresAt =
      options.expiresOn ?? new Date(Date.now() + (options.permissions === "r" ? 5 : 15) * 60_000);
    return {
      url: `https://storage.example/${encodeURIComponent(blobName)}?sp=${options.permissions}&se=${encodeURIComponent(expiresAt.toISOString())}`,
      expiresAt,
    };
  },
  headBlob: async (blobName: string) =>
    fakeBlobs.get(blobName) ?? { exists: false, sizeBytes: 0, contentType: null, sha256: null },
  downloadBlob: async (blobName: string) => {
    const data = fakeBlobData.get(blobName);
    if (!data) throw new Error(`fake blob not found: ${blobName}`);
    return data;
  },
  uploadBlob: async (
    blobName: string,
    data: Buffer,
    options: { contentType: string; sha256?: string },
  ) => {
    fakeBlobData.set(blobName, data);
    fakeBlobs.set(blobName, {
      exists: true,
      sizeBytes: data.byteLength,
      contentType: options.contentType,
      sha256: options.sha256 ?? null,
    });
  },
  containerClient: () => ({}),
  resetAzureBlobForTests: resetFakeAzure,
};
