import busboy from "busboy";
import fs from "fs";
import os from "os";
import path from "path";
import { IncomingMessage } from "http";

export interface DiskFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  path: string;
  size: number;
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: DiskFile[];
}

/**
 * Parses a multipart request and streams files directly to /tmp disk.
 * No file content is held in RAM.
 */
export function parseMultipartToDisk(req: IncomingMessage, headers: Record<string, string>): Promise<ParsedMultipart> {
  return new Promise((resolve, reject) => {
    // defParamCharset defaults to 'latin1' in busboy, which mojibakes non-ASCII
    // filenames (e.g. Chinese 小規模收據.pdf -> å°è¦æ¨¡æ¶æ.pdf) since browsers
    // send the multipart filename as UTF-8. Decode as UTF-8 so the stored name
    // and S3 key keep the original characters.
    const bb = busboy({ headers, defParamCharset: "utf8" });
    const fields: Record<string, string> = {};
    const files: DiskFile[] = [];
    const writePromises: Promise<void>[] = [];

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (fieldname, fileStream, info) => {
      const { filename, mimeType } = info;
      const tmpPath = path.join(os.tmpdir(), `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      const writeStream = fs.createWriteStream(tmpPath);
      let size = 0;

      fileStream.on("data", (chunk) => { size += chunk.length; });

      const writePromise = new Promise<void>((res, rej) => {
        writeStream.on("finish", () => {
          files.push({ fieldname, originalname: filename, mimetype: mimeType, path: tmpPath, size });
          res();
        });
        writeStream.on("error", rej);
        fileStream.on("error", rej);
      });

      fileStream.pipe(writeStream);
      writePromises.push(writePromise);
    });

    bb.on("finish", async () => {
      try {
        await Promise.all(writePromises);
        resolve({ fields, files });
      } catch (err) {
        reject(err);
      }
    });

    bb.on("error", reject);
    req.pipe(bb);
  });
}

/** Delete a list of temp files from disk, ignoring errors */
export function cleanupTempFiles(files: DiskFile[]): void {
  for (const file of files) {
    fs.unlink(file.path, () => {});
  }
}
