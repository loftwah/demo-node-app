import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

export interface AwsConfig {
  region?: string;
}

const defaultRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2';
const s3Endpoint = process.env.S3_ENDPOINT;
const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE || 'true').toLowerCase() === 'true';

export const s3Client = new S3Client({
  region: defaultRegion,
  endpoint: s3Endpoint,
  forcePathStyle,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

export async function checkS3(bucketName: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    return true;
  } catch {
    return false;
  }
}

export async function putS3Text(bucketName: string, key: string, text: string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: text,
      ContentType: 'text/plain; charset=utf-8',
    })
  );
}

export async function getS3Text(bucketName: string, key: string): Promise<string | null> {
  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    const stream = resp.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch (err) {
    return null;
  }
}

export async function deleteS3Object(bucketName: string, key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}
