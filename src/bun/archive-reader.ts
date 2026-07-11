import { inflateRawSync } from "node:zlib";

export type ZipReadLimits = {
  maxFileCount: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

const DEFAULT_LIMITS: ZipReadLimits = {
  maxFileCount: 10_000,
  maxFileBytes: 500_000_000,
  maxTotalBytes: 4_000_000_000,
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(bytes: Buffer) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Unrecognized ZIP archive format");
}

export function readZipEntries(input: Uint8Array, limits: Partial<ZipReadLimits> = {}) {
  const options = { ...DEFAULT_LIMITS, ...limits };
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("Multi-disk and ZIP64 project transfers are not supported");
  if (entryCount > options.maxFileCount || centralOffset + centralSize > bytes.length) throw new Error("ZIP archive exceeds safe limits or is truncated");

  const files = new Map<string, Uint8Array>();
  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP central directory is invalid");
    const madeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > bytes.length) throw new Error("ZIP entry metadata is truncated");
    const name = bytes.subarray(nameStart, nameEnd).toString("utf8");
    offset = nameEnd + extraLength + commentLength;
    if (flags & 0x0001) throw new Error(`Encrypted ZIP entries are not supported: ${name}`);
    if (compression !== 0 && compression !== 8) throw new Error(`Unsupported ZIP compression method for ${name}`);
    const hostSystem = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (hostSystem === 3 && (unixMode & 0o170000) === 0o120000) throw new Error(`Symbolic links are not allowed in project transfers: ${name}`);
    if (name.endsWith("/")) continue;
    if (uncompressedSize > options.maxFileBytes || compressedSize > options.maxFileBytes) throw new Error(`ZIP entry is too large: ${name}`);
    totalBytes += uncompressedSize;
    if (totalBytes > options.maxTotalBytes) throw new Error("Expanded ZIP archive is too large");
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local header is invalid: ${name}`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error(`ZIP entry is truncated: ${name}`);
    const compressed = bytes.subarray(dataStart, dataEnd);
    const content = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: options.maxFileBytes });
    if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) throw new Error(`ZIP entry failed integrity validation: ${name}`);
    if (files.has(name)) throw new Error(`Duplicate ZIP entry is not allowed: ${name}`);
    files.set(name, content);
  }
  if (offset !== centralOffset + centralSize) throw new Error("ZIP central directory size does not match its entries");
  return files;
}
