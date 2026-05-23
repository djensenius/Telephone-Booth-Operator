export type FakeBlobHead = {
  exists: boolean;
  sizeBytes: number;
  contentType: string | null;
  sha256: string | null;
};

export const fakeBlobs = new Map<string, FakeBlobHead>();

export const resetFakeAzure = (): void => {
  fakeBlobs.clear();
};

export const fakeAzureModule = {
  generateSasUrl: (blobName: string, options: { permissions: "r" | "cw"; expiresOn?: Date }) => {
    const expiresAt = options.expiresOn ?? new Date(Date.now() + (options.permissions === "r" ? 5 : 15) * 60_000);
    return {
      url: `https://storage.example/${encodeURIComponent(blobName)}?sp=${options.permissions}&se=${encodeURIComponent(expiresAt.toISOString())}`,
      expiresAt,
    };
  },
  headBlob: async (blobName: string) =>
    fakeBlobs.get(blobName) ?? { exists: false, sizeBytes: 0, contentType: null, sha256: null },
  containerClient: () => ({}),
  resetAzureBlobForTests: resetFakeAzure,
};
