import {
  BlobSASPermissions,
  BlobServiceClient,
  type BlobSASSignatureValues,
  type ContainerClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";

export type SasPermissions = "r" | "cw";

export type GenerateSasOptions = {
  permissions: SasPermissions;
  expiresOn?: Date;
  contentType?: string;
};

export type BlobHead = {
  exists: boolean;
  sizeBytes: number;
  contentType: string | null;
  sha256: string | null;
};

type AzureState = {
  serviceClient: BlobServiceClient;
  containerClient: ContainerClient;
  credential: StorageSharedKeyCredential;
  containerName: string;
};

let state: AzureState | null = null;

const developmentAccount = {
  name: "devstoreaccount1",
  key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  blobEndpoint: "http://localhost:10000/devstoreaccount1",
};

const connectionParts = (connectionString: string): Map<string, string> => {
  const parts = new Map<string, string>();
  for (const part of connectionString.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    parts.set(part.slice(0, separator), part.slice(separator + 1));
  }
  return parts;
};

const resolveConnection = () => {
  const raw = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim() || "UseDevelopmentStorage=true";
  if (raw === "UseDevelopmentStorage=true") return developmentAccount;

  const parts = connectionParts(raw);
  const name = parts.get("AccountName");
  const key = parts.get("AccountKey");
  const blobEndpoint = parts.get("BlobEndpoint");
  const protocol = parts.get("DefaultEndpointsProtocol") ?? "https";
  const suffix = parts.get("EndpointSuffix") ?? "core.windows.net";

  if (!name || !key) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING must include AccountName and AccountKey until managed-identity SAS issuing is enabled.",
    );
  }

  return {
    name,
    key,
    blobEndpoint: blobEndpoint ?? `${protocol}://${name}.blob.${suffix}`,
  };
};

const init = (): AzureState => {
  if (state) return state;

  const connection = resolveConnection();
  const credential = new StorageSharedKeyCredential(connection.name, connection.key);
  const serviceClient = new BlobServiceClient(connection.blobEndpoint, credential);
  const containerName = process.env.AZURE_BLOB_CONTAINER?.trim() || "booth-recordings";
  const client = serviceClient.getContainerClient(containerName);
  state = { serviceClient, containerClient: client, credential, containerName };
  return state;
};

const ttlMinutes = (envName: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[envName] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const uploadExpiresAt = (): Date =>
  new Date(Date.now() + ttlMinutes("AZURE_SAS_TTL_MINUTES", 15) * 60_000);

export const readExpiresAt = (): Date =>
  new Date(Date.now() + ttlMinutes("AZURE_SAS_READ_TTL_MINUTES", 5) * 60_000);

export const containerClient = (): ContainerClient => init().containerClient;

export const generateSasUrl = (
  blobName: string,
  options: GenerateSasOptions,
): { url: string; expiresAt: Date } => {
  const { containerClient: client, credential, containerName } = init();
  const expiresAt =
    options.expiresOn ?? (options.permissions === "r" ? readExpiresAt() : uploadExpiresAt());
  const startsOn = new Date(Date.now() - 60_000);
  const signatureValues: BlobSASSignatureValues = {
    containerName,
    blobName,
    permissions: BlobSASPermissions.parse(options.permissions),
    startsOn,
    expiresOn: expiresAt,
  };
  if (options.contentType) signatureValues.contentType = options.contentType;
  const sas = generateBlobSASQueryParameters(signatureValues, credential).toString();

  return { url: `${client.getBlockBlobClient(blobName).url}?${sas}`, expiresAt };
};

export const headBlob = async (blobName: string): Promise<BlobHead> => {
  const blob = containerClient().getBlockBlobClient(blobName);
  try {
    const properties = await blob.getProperties();
    return {
      exists: true,
      sizeBytes: properties.contentLength ?? 0,
      contentType: properties.contentType ?? null,
      sha256: properties.metadata?.sha256 ?? null,
    };
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : null;
    if (statusCode === 404) return { exists: false, sizeBytes: 0, contentType: null, sha256: null };
    throw error;
  }
};

export const resetAzureBlobForTests = (): void => {
  state = null;
};
