import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ImageValidationResult {
  valid: boolean;
  ext?: "jpg" | "png" | "webp";
  mime?: string;
  error?: "invalid_magic_bytes" | "empty_buffer" | "pdf_unsupported";
}

/**
 * Validates image buffer using magic bytes (file signature).
 * Rejects .exe, pdf, scripts, or corrupted files disguised as images.
 */
export function validateImageBuffer(buffer: Buffer): ImageValidationResult {
  if (!buffer || buffer.length < 12) {
    return { valid: false, error: "empty_buffer" };
  }

  // 0. PDF: %PDF (25 50 44 46)
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return { valid: false, error: "pdf_unsupported" };
  }

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { valid: true, ext: "png", mime: "image/png" };
  }

  // 2. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, ext: "jpg", mime: "image/jpeg" };
  }

  // 3. WEBP: RIFF (bytes 0..3) ... WEBP (bytes 8..11)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { valid: true, ext: "webp", mime: "image/webp" };
  }

  return { valid: false, error: "invalid_magic_bytes" };
}

/**
 * Safely writes receipt image to UPLOAD_DIR with uuidv4 filename and path traversal prevention.
 */
export async function saveReceiptImage(
  buffer: Buffer,
  uploadDir: string,
  ext: "jpg" | "png" | "webp",
): Promise<string> {
  const fileName = `${randomUUID()}.${ext}`;
  const baseDir = resolve(uploadDir);
  const targetPath = resolve(baseDir, fileName);

  // Security check: ensure targetPath is strictly inside baseDir
  if (!targetPath.startsWith(baseDir)) {
    throw new Error("Path traversal attempt detected");
  }

  await mkdir(baseDir, { recursive: true });
  await writeFile(targetPath, buffer);

  return targetPath;
}
