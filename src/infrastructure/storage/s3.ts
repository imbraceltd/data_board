/**
 * S3 upload helper for public-read files (CSV exports, etc.).
 * Mirrors legacy backend's core/S3/index.js uploadFile behavior.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import config from "../../config";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: config.aws.region,
      credentials: config.aws.accessKeyId
        ? {
            accessKeyId: config.aws.accessKeyId,
            secretAccessKey: config.aws.secretAccessKey,
          }
        : undefined,
    });
  }
  return client;
}

/**
 * Upload a public-read object to S3.
 *
 * `forceDownload=false` (default) writes `Content-Disposition: inline;
 * filename="..."` so PDFs and images preview natively in the browser, while
 * still preserving the original filename if the user saves. Pass
 * `forceDownload=true` for things like CSV exports where the user should
 * always get a download (browser would otherwise render the CSV as text).
 */
export async function uploadPublicFile(
  key: string,
  body: Buffer,
  contentType: string,
  fileName?: string,
  forceDownload = false,
): Promise<{ Location: string; Key: string }> {
  const bucket = config.aws.s3Bucket;
  if (!bucket) throw new Error("AWS_S3_BUCKET not configured");
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ACL: "public-read",
    ...(fileName && {
      ContentDisposition: `${forceDownload ? "attachment" : "inline"}; filename="${encodeURIComponent(fileName)}"`,
    }),
  });
  await getClient().send(cmd);
  const location = `https://${bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;
  return { Location: location, Key: key };
}
