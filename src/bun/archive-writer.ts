import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

type ZipEntry = {
  name: string;
  data: Buffer;
  mtime: Date;
  isDirectory: boolean;
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();
const ZIP_UTF8_FLAG = 0x0800;

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

async function collectEntries(root: string, current = root): Promise<ZipEntry[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const output: ZipEntry[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    const rel = relative(root, path).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      const info = await stat(path);
      output.push({ name: `${rel}/`, data: Buffer.alloc(0), mtime: info.mtime, isDirectory: true });
      output.push(...(await collectEntries(root, path)));
    } else if (entry.isFile()) {
      const [info, data] = await Promise.all([stat(path), readFile(path)]);
      output.push({ name: rel, data, mtime: info.mtime, isDirectory: false });
    }
  }
  return output.sort((a, b) => a.name.localeCompare(b.name));
}

function localHeader(entry: ZipEntry) {
  const name = Buffer.from(entry.name);
  const { time, date } = dosDateTime(entry.mtime);
  const crc = entry.isDirectory ? 0 : crc32(entry.data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name, entry.data]);
}

function centralHeader(entry: ZipEntry, offset: number) {
  const name = Buffer.from(entry.name);
  const { time, date } = dosDateTime(entry.mtime);
  const crc = entry.isDirectory ? 0 : crc32(entry.data);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(entry.isDirectory ? 0x10 : 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

export async function writeZipFromDirectory(sourceDir: string, zipPath: string) {
  const entries = await collectEntries(sourceDir);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const local = localHeader(entry);
    localParts.push(local);
    centralParts.push(centralHeader(entry, offset));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const archive = Buffer.concat([...localParts, central, endOfCentralDirectory(entries.length, central.length, offset)]);
  await mkdir(dirname(zipPath), { recursive: true });
  await writeFile(zipPath, archive);
}
