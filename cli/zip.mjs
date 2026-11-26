import { inflateRawSync } from "node:zlib";

// 最小限の zip の読み取り。中央ディレクトリを読み、無圧縮（stored）と deflate だけを展開する。
// ビルドの zip は合計 100MB の上限があるので、ファイル全体をメモリに載せて読む。

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** zip を読めなかったときの例外。message は作者へそのまま出す日本語。 */
export class ZipError extends Error {}

/**
 * @typedef {{ path: string, size: number, read: () => Buffer }} ZipEntry
 */

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function findEndOfCentralDirectory(buffer) {
  const stop = Math.max(0, buffer.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError("zip として読めません（終端のレコードが見つかりません）。");
}

/**
 * CP437 の名前は ASCII の範囲だけを受ける。ビルドのファイル名はほぼ ASCII で、範囲外を推測で読むと
 * Studio と違う名前で上がりうる。
 * @param {Buffer} raw
 * @param {boolean} utf8
 */
function decodeName(raw, utf8) {
  if (utf8) return raw.toString("utf8");
  for (const byte of raw) {
    if (byte >= 0x80) {
      throw new ZipError(
        "zip の中に、文字コードの分からないファイル名があります。ファイル名を英数字にするか、UTF-8 で zip にしてください。",
      );
    }
  }
  return raw.toString("latin1");
}

/**
 * zip の中のファイルを並べる。ディレクトリのエントリは飛ばす。中身は read() を呼んだときに展開する。
 * @param {Buffer} buffer
 * @param {{ maxEntryBytes?: number }} [options]
 * @returns {ZipEntry[]}
 */
export function readZipEntries(buffer, options = {}) {
  const maxEntryBytes = options.maxEntryBytes ?? Number.MAX_SAFE_INTEGER;
  if (buffer.length < EOCD_MIN_BYTES) throw new ZipError("zip として読めません（短すぎます）。");
  const eocd = findEndOfCentralDirectory(buffer);
  const locator = eocd - 20;
  if (locator >= 0 && buffer.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    throw new ZipError("ZIP64 形式の zip は読めません。通常の zip で作り直してください。");
  }
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError("ZIP64 形式の zip は読めません。通常の zip で作り直してください。");
  }
  if (diskNumber !== 0) throw new ZipError("分割された zip は読めません。");
  if (centralOffset + centralSize > eocd) {
    throw new ZipError("zip として読めません（中央ディレクトリが壊れています）。");
  }

  /** @type {ZipEntry[]} */
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError("zip として読めません（中央ディレクトリが壊れています）。");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = decodeName(
      buffer.subarray(offset + 46, offset + 46 + nameLength),
      (flags & FLAG_UTF8) !== 0,
    );
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/") || name.endsWith("\\")) continue;
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("ZIP64 形式の zip は読めません。通常の zip で作り直してください。");
    }
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipError(`パスワード付きの zip は読めません: ${name}`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError(
        `zip の圧縮方式（${method}）に対応していません: ${name}。通常の zip（Deflate）で作り直してください。`,
      );
    }
    if (size > maxEntryBytes) {
      throw new ZipError(`zip の中のファイルが大きすぎます: ${name}`);
    }

    entries.push({
      path: name,
      size,
      read: () => readEntry(buffer, { name, method, crc, compressedSize, size, localOffset }),
    });
  }
  return entries;
}

/**
 * @param {Buffer} buffer
 * @param {{ name: string, method: number, crc: number, compressedSize: number, size: number, localOffset: number }} entry
 */
function readEntry(buffer, entry) {
  const { localOffset } = entry;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new ZipError(`zip の中のファイルを読めません: ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length)
    throw new ZipError(`zip の中のファイルが途中で切れています: ${entry.name}`);
  const compressed = buffer.subarray(start, end);
  let data;
  if (entry.method === METHOD_STORED) {
    data = Buffer.from(compressed);
  } else {
    try {
      // 中央ディレクトリの大きさより大きく展開しない。偽った大きさで展開を膨らませる zip を止める。
      data = inflateRawSync(compressed, { maxOutputLength: Math.max(entry.size, 1) });
    } catch {
      throw new ZipError(`zip の中のファイルを展開できません: ${entry.name}`);
    }
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) {
    throw new ZipError(`zip の中のファイルが壊れています: ${entry.name}`);
  }
  return data;
}

/** @type {Uint32Array | null} */
let crcTable = null;

/** @param {Uint8Array} data */
export function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = crcTable[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
