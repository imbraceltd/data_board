/**
 * Public-file upload via the internal file-service (local-disk storage).
 *
 * Drop-in replacement for the S3 `uploadPublicFile` helper (`./s3`): identical
 * signature and return shape, but instead of pushing to AWS S3 it streams the
 * buffer to file-service (`POST {FS_SERVICE_URL}/upload`), which persists to the
 * server's local volume (file-service `LOCAL_PATH`). The returned `Location` is
 * the public, no-auth download URL served through app-gateway
 * (`/files/download/:key` → file-service `/api/files/download/:key`).
 *
 * To revert to S3: point the import in board.controller.ts back at `./s3` and
 * set AWS_S3_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION.
 */

import axios from "axios";
import FormData from "form-data";
import config from "../../config";
import logger from "../logging/logger";

export async function uploadPublicFile(
  key: string,
  body: Buffer,
  contentType: string,
  _fileName?: string,
  forceDownload = false,
): Promise<{ Location: string; Key: string }> {
  // file-service's local adapter stores by the *basename* of the uploaded
  // filename and serves it back from a single flat directory. Flatten the
  // path-style key (e.g. `board/<org>/file_xxx.csv`) into one slash-free
  // segment so we (a) keep the org/uuid uniqueness the S3 key carried and
  // (b) stay routable through the `/files/download/:key` single-segment route.
  const storedKey = key.replace(/\//g, "__");

  // form-data + axios take a Node Buffer directly (no Blob/BlobPart juggling).
  const form = new FormData();
  form.append("file", body, {
    filename: storedKey,
    contentType,
    knownLength: body.length,
  });

  let savedKey = storedKey;
  try {
    const res = await axios.post(`${config.fsServiceUrl}/upload`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    savedKey = res.data?.data?.key || res.data?.data?.Key || storedKey;
  } catch (err: any) {
    const status = err?.response?.status;
    const detail = err?.response?.data
      ? JSON.stringify(err.response.data)
      : err?.message || String(err);
    throw new Error(
      `file-service upload failed${status ? ` (${status})` : ""}: ${detail}`,
    );
  }

  // Public, no-auth download URL: app-gateway `/files/download` proxies to
  // file-service `/api/files/download/:key`. `?download=true` forces an
  // attachment disposition (CSV exports); omitted = inline preview (PDF/img).
  const base = config.appGatewayHost.replace(/\/+$/, "");
  const Location = `${base}/files/download/${encodeURIComponent(savedKey)}${
    forceDownload ? "?download=true" : ""
  }`;

  logger.info(`Public file uploaded to file-service: ${savedKey}`);
  return { Location, Key: savedKey };
}
