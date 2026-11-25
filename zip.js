/* QSL LOGBOOK — tiny ZIP reader/writer (store-only writer, deflate reader)
   Works in the browser as window.QSLZip, and in Node for tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.QSLZip = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return encoder.encode(String(value));
  }

  function dosDateTime(date) {
    const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
    let year = d.getFullYear();
    if (year < 1980) year = 1980;
    if (year > 2107) year = 2107;
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xffff, date: day & 0xffff };
  }

  /**
   * Build an uncompressed ZIP archive.
   * @param {{name: string, data: string|Uint8Array, date?: Date}[]} files
   * @returns {Uint8Array}
   */
  function createZip(files) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("ZIP 至少需要一个文件。");
    }

    const entries = [];
    let localSize = 0;
    let centralSize = 0;

    for (const file of files) {
      if (!file || !file.name) throw new Error("ZIP 文件名不能为空。");
      const name = toBytes(file.name);
      const data = toBytes(file.data);
      const stamp = dosDateTime(file.date);
      const checksum = crc32(data);
      if (name.length > 0xffff) throw new Error("ZIP 文件名过长。");
      if (data.length > 0xffffffff) throw new Error("单个文件过大，无法打包。");

      localSize += 30 + name.length + data.length;
      centralSize += 46 + name.length;
      entries.push({ name, data, checksum, stamp });
    }

    const endSize = 22;
    const total = localSize + centralSize + endSize;
    if (total > 0xffffffff) throw new Error("数据过大，无法打包。");
    if (entries.length > 0xffff) throw new Error("文件数量过多，无法打包。");

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let offset = 0;
    const centralOffsets = [];

    for (const entry of entries) {
      centralOffsets.push(offset);
      view.setUint32(offset, SIG_LOCAL, true);
      view.setUint16(offset + 4, 20, true);
      view.setUint16(offset + 6, 0x0800, true); // UTF-8 names
      view.setUint16(offset + 8, 0, true); // stored
      view.setUint16(offset + 10, entry.stamp.time, true);
      view.setUint16(offset + 12, entry.stamp.date, true);
      view.setUint32(offset + 14, entry.checksum, true);
      view.setUint32(offset + 18, entry.data.length, true);
      view.setUint32(offset + 22, entry.data.length, true);
      view.setUint16(offset + 26, entry.name.length, true);
      view.setUint16(offset + 28, 0, true);
      out.set(entry.name, offset + 30);
      out.set(entry.data, offset + 30 + entry.name.length);
      offset += 30 + entry.name.length + entry.data.length;
    }

    const centralStart = offset;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      view.setUint32(offset, SIG_CENTRAL, true);
      view.setUint16(offset + 4, 20, true); // made by
      view.setUint16(offset + 6, 20, true); // needed
      view.setUint16(offset + 8, 0x0800, true);
      view.setUint16(offset + 10, 0, true);
      view.setUint16(offset + 12, entry.stamp.time, true);
      view.setUint16(offset + 14, entry.stamp.date, true);
      view.setUint32(offset + 16, entry.checksum, true);
      view.setUint32(offset + 20, entry.data.length, true);
      view.setUint32(offset + 24, entry.data.length, true);
      view.setUint16(offset + 28, entry.name.length, true);
      view.setUint16(offset + 30, 0, true);
      view.setUint16(offset + 32, 0, true);
      view.setUint16(offset + 34, 0, true);
      view.setUint16(offset + 36, 0, true);
      view.setUint32(offset + 38, 0, true);
      view.setUint32(offset + 42, centralOffsets[i], true);
      out.set(entry.name, offset + 46);
      offset += 46 + entry.name.length;
    }

    const centralLength = offset - centralStart;
    view.setUint32(offset, SIG_EOCD, true);
    view.setUint16(offset + 4, 0, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, entries.length, true);
    view.setUint16(offset + 10, entries.length, true);
    view.setUint32(offset + 12, centralLength, true);
    view.setUint32(offset + 16, centralStart, true);
    view.setUint16(offset + 20, 0, true);
    offset += 22;

    if (offset !== out.length) {
      throw new Error("ZIP 写入长度不一致。");
    }
    return out;
  }

  function findEocd(view) {
    const length = view.byteLength;
    const min = Math.max(0, length - 22 - 0xffff);
    for (let i = length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  function decodeName(bytes) {
    try {
      return decoder.decode(bytes);
    } catch (error) {
      return "";
    }
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "function") {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        // Fall through to the friendly error below.
      }
    }
    throw new Error("当前浏览器无法解压此 ZIP，请改用 .json 备份文件。");
  }

  /**
   * Read a JSON entry from a ZIP backup.
   * @param {ArrayBuffer|Uint8Array} input
   * @param {string} preferredName
   * @returns {Promise<{name: string, text: string}>}
   */
  async function readTextFromZip(input, preferredName) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 22) throw new Error("ZIP 文件不完整。");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(view);
    if (eocd < 0) throw new Error("无法识别这个 ZIP 文件。");

    const diskNumber = view.getUint16(eocd + 4, true);
    const centralDisk = view.getUint16(eocd + 6, true);
    let count = view.getUint16(eocd + 8, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (diskNumber !== 0 || centralDisk !== 0) {
      throw new Error("不支持分卷 ZIP 文件。");
    }
    if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      throw new Error("暂不支持 ZIP64 文件，请导出 .json 备份。");
    }
    if (centralOffset + centralSize > bytes.length) {
      throw new Error("ZIP 中央目录损坏。");
    }

    const wanted = (preferredName || "qsl-backup.json").toLowerCase();
    const candidates = [];
    let pointer = centralOffset;

    for (let i = 0; i < count; i++) {
      if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== SIG_CENTRAL) {
        throw new Error("ZIP 中央目录损坏。");
      }
      const flags = view.getUint16(pointer + 8, true);
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const uncompressedSize = view.getUint32(pointer + 24, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      if (pointer + 46 + nameLength > bytes.length) {
        throw new Error("ZIP 文件名读取失败。");
      }
      const name = decodeName(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
      pointer += 46 + nameLength + extraLength + commentLength;

      if (!name || name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
      if (flags & 0x1) continue; // encrypted entries are not supported
      const base = name.split("/").pop().toLowerCase();
      const score = base === wanted ? 3 : base.endsWith(".json") ? 2 : 0;
      if (score > 0) {
        candidates.push({
          name,
          score,
          method,
          compressedSize,
          uncompressedSize,
          localOffset,
        });
      }
    }

    if (candidates.length === 0) {
      throw new Error("ZIP 中未找到 JSON 备份文件。");
    }

    candidates.sort(function (a, b) {
      return b.score - a.score;
    });
    const chosen = candidates[0];

    if (chosen.localOffset + 30 > bytes.length) throw new Error("ZIP 数据偏移无效。");
    if (view.getUint32(chosen.localOffset, true) !== SIG_LOCAL) throw new Error("ZIP 文件头损坏。");
    const localNameLength = view.getUint16(chosen.localOffset + 26, true);
    const localExtraLength = view.getUint16(chosen.localOffset + 28, true);
    const dataStart = chosen.localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + chosen.compressedSize > bytes.length) throw new Error("ZIP 数据不完整。");
    const payload = bytes.subarray(dataStart, dataStart + chosen.compressedSize);

    let raw;
    if (chosen.method === 0) {
      raw = payload;
    } else if (chosen.method === 8) {
      raw = await inflateRaw(payload);
      if (raw.length !== chosen.uncompressedSize) {
        throw new Error("ZIP 解压后的数据长度异常。");
      }
    } else {
      throw new Error("ZIP 使用了不支持的压缩方式（" + chosen.method + "）。");
    }

    return { name: chosen.name, text: decoder.decode(raw) };
  }

  return {
    createZip: createZip,
    readTextFromZip: readTextFromZip,
    crc32: crc32,
  };
});
