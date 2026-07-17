// Minimal, dependency-free USTAR (tar) writer/reader. The admin data
// export/import bundles a JSON database dump plus all audio blobs into a
// single tar archive so operators can back up and restore an installation
// with standard tooling (`tar tf backup.tar` works). Archives are built and
// read fully in memory — a Telephone Booth installation's data set is small
// enough that streaming is unnecessary and the simplicity is worth it.

const BLOCK_SIZE = 512;

export type ArchiveEntry = {
  name: string;
  data: Buffer;
};

const writeOctal = (buffer: Buffer, value: number, offset: number, length: number): void => {
  // USTAR numeric fields are zero-padded octal terminated by a NUL. The field
  // holds `length - 1` octal digits.
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(text, offset, length - 1, "ascii");
  buffer.writeUInt8(0, offset + length - 1);
};

const headerFor = (name: string, size: number): Buffer => {
  if (Buffer.byteLength(name, "utf8") > 100) {
    throw new Error(`archive entry name too long: ${name}`);
  }
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 0o644, 100, 8); // mode
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, size, 124, 12); // size
  writeOctal(header, 0, 136, 12); // mtime (deterministic)
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, 6, "ascii"); // magic
  header.write("00", 263, 2, "ascii"); // version

  // Checksum: computed with the checksum field filled with spaces, then
  // written as 6 octal digits, a NUL, and a space.
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) checksum += header[i] ?? 0;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header.writeUInt8(0, 154);
  header.writeUInt8(0x20, 155);
  return header;
};

const padTo512 = (size: number): number =>
  size % BLOCK_SIZE === 0 ? 0 : BLOCK_SIZE - (size % BLOCK_SIZE);

export const createTar = (entries: ArchiveEntry[]): Buffer => {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(headerFor(entry.name, entry.data.byteLength));
    chunks.push(entry.data);
    const padding = padTo512(entry.data.byteLength);
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  // Two zero blocks mark the end of the archive.
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(chunks);
};

const isZeroBlock = (buffer: Buffer, offset: number): boolean => {
  for (let i = offset; i < offset + BLOCK_SIZE; i += 1) {
    if (buffer[i] !== 0) return false;
  }
  return true;
};

const readString = (buffer: Buffer, offset: number, length: number): string => {
  const slice = buffer.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? length : nul).toString("utf8");
};

export const readTar = (archive: Buffer): ArchiveEntry[] => {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= archive.byteLength) {
    if (isZeroBlock(archive, offset)) break;
    const name = readString(archive, offset, 100);
    const sizeText = readString(archive, offset + 124, 12).trim();
    const size = sizeText.length > 0 ? Number.parseInt(sizeText, 8) : 0;
    const dataStart = offset + BLOCK_SIZE;
    const data = archive.subarray(dataStart, dataStart + size);
    entries.push({ name, data: Buffer.from(data) });
    offset = dataStart + size + padTo512(size);
  }
  return entries;
};
