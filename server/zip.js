'use strict';
// Minimal .zip reader so export files can be imported without unzipping them first.
const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRY = 600 * 1024 * 1024;

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done);
    if (!n) break;
    done += n;
  }
  return buf.subarray(0, done);
}

function listEntries(fd) {
  const size = fs.fstatSync(fd).size;
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This does not look like a valid .zip file.');
  const total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('This .zip is too large to read directly. Unzip it and import the files inside instead.');
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const entries = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(fd, entry) {
  if (entry.size > MAX_ENTRY || entry.size === 0xffffffff) throw new Error(`"${entry.name}" is too large to import from the zip.`);
  const head = readAt(fd, entry.offset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) throw new Error('The .zip file is damaged.');
  const dataStart = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const data = readAt(fd, dataStart, entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
  throw new Error(`"${entry.name}" uses a compression type this app cannot read.`);
}

module.exports = { listEntries, readEntry };
