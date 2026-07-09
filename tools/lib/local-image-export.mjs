import path from "node:path";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_JFIF_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

export function repairBrowserImageBytes(input, contentType, localPath = "") {
  const bytes = Buffer.from(input);
  const ext = path.extname(localPath).toLowerCase();
  if (isPng(contentType, ext) && bytes.length >= 16 && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    PNG_HEADER.copy(bytes, 0);
    return bytes;
  }

  if (isJpeg(contentType, ext) && bytes.length >= 22 && bytes[20] === 0xff && bytes[21] === 0xdb) {
    JPEG_JFIF_HEADER.copy(bytes, 0);
    return bytes;
  }

  if (isJpeg(contentType, ext) && bytes.length >= 22 && bytes.subarray(11, 18).toString("ascii") === "ROFILE\0") {
    const nextMarker = findJpegMarker(bytes, 20);
    if (nextMarker > 4) {
      bytes[0] = 0xff;
      bytes[1] = 0xd8;
      bytes[2] = 0xff;
      bytes[3] = 0xe2;
      bytes.writeUInt16BE(nextMarker - 4, 4);
      bytes.write("ICC_PROFILE\0", 6, "ascii");
      return bytes;
    }
  }

  if (isWebp(contentType, ext) && bytes.length >= 16 && bytes.subarray(12, 16).toString("ascii").startsWith("VP8")) {
    bytes.write("RIFF", 0, "ascii");
    bytes.writeUInt32LE(Math.max(0, bytes.length - 8), 4);
    bytes.write("WEBP", 8, "ascii");
    return bytes;
  }

  return bytes;
}

function findJpegMarker(bytes, start) {
  for (let index = start; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] !== 0x00 && bytes[index + 1] !== 0xff) {
      return index;
    }
  }
  return -1;
}

export function browserImageCategory(contentType, localPath) {
  const ext = path.extname(localPath).toLowerCase();
  if (isPng(contentType, ext)) {
    return "png";
  }
  if (isJpeg(contentType, ext)) {
    return "jpg";
  }
  if (isWebp(contentType, ext)) {
    return "webp";
  }
  if (contentType === "image/gif" || ext === ".gif") {
    return "gif";
  }
  return null;
}

function isPng(contentType, ext) {
  return contentType === "image/png" || ext === ".png";
}

function isJpeg(contentType, ext) {
  return contentType === "image/jpeg" || ext === ".jpg" || ext === ".jpeg";
}

function isWebp(contentType, ext) {
  return contentType === "image/webp" || ext === ".webp";
}
