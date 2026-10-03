import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3'

// Document bodies live in S3 (SeaweedFS in the lab): docs/<id>/state.json, docs/<id>/rev/<n>.json, docs/<id>/export.md.
export class Storage {
  constructor({ endpoint, bucket, accessKey, secretKey, region = 'us-east-1' }) {
    if (!endpoint || !bucket) throw new Error('S3_ENDPOINT and S3_BUCKET are required')
    this.bucket = bucket
    this.client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId: accessKey ?? '', secretAccessKey: secretKey ?? '' } })
  }
  async ensureBucket() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return true } catch {}
    try { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })); return true }
    catch (e) { console.error(`bucket ${this.bucket} is missing and could not be created: ${e.message}`); return false }
  }
  async putText(key, body, contentType = 'text/plain; charset=utf-8') { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })) }
  async getText(key) {
    try { const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); return await out.Body.transformToString() }
    catch (e) { if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null; throw e }
  }
  async putJson(key, value) { await this.putText(key, JSON.stringify(value), 'application/json') }
  async getJson(key) { const text = await this.getText(key); return text == null ? null : JSON.parse(text) }
  async list(prefix) {
    const keys = []; let token
    do {
      const out = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }))
      for (const o of out.Contents ?? []) keys.push(o.Key)
      token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token)
    return keys
  }
  async delete(key) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })) }
}
export const storageFromEnv = (env = process.env) => new Storage({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET ?? 'notebook-duplex', accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY, region: env.S3_REGION ?? 'us-east-1' })
