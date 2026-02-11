import { AbstractFileProviderService } from "@medusajs/framework/utils"
import { 
  S3Client, 
  PutObjectCommand, 
  DeleteObjectCommand, 
  GetObjectCommand 
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Logger } from "@medusajs/framework/types"
import stream from "stream"

type InjectedDependencies = {
  logger: Logger
}

interface S3FileServiceOptions {
  bucket: string
  region: string
  access_key_id: string
  secret_access_key: string
  prefix?: string
  endpoint?: string
  cache_control?: string
}

export default class S3NoACLFileService extends AbstractFileProviderService {
  static identifier = "s3-no-acl"
  
  protected client_: S3Client
  protected bucket_: string
  protected prefix_: string
  protected cacheControl_: string
  protected logger_: Logger
  protected region_: string

  constructor(
    { logger }: InjectedDependencies,
    options: S3FileServiceOptions
  ) {
    super()
    
    this.logger_ = logger
    this.bucket_ = options.bucket
    this.prefix_ = options.prefix || ""
    this.cacheControl_ = options.cache_control || "public, max-age=31536000"
    this.region_ = options.region

    this.client_ = new S3Client({
      region: options.region,
      credentials: {
        accessKeyId: options.access_key_id,
        secretAccessKey: options.secret_access_key,
      },
      endpoint: options.endpoint,
    })

    this.logger_.info(`S3 No ACL File Service initialized for bucket: ${this.bucket_}`)
  }

  async upload(file: {
    filename: string
    mimeType: string
    content: string | Buffer | stream.Readable
  }): Promise<{ url: string; key: string }> {
    const key = `${this.prefix_}${file.filename}`
    
    try {
      let body: Buffer | stream.Readable

      if (typeof file.content === "string") {
        body = Buffer.from(file.content, "base64")
      } else {
        body = file.content
      }

      const command = new PutObjectCommand({
        Bucket: this.bucket_,
        Key: key,
        Body: body,
        ContentType: file.mimeType,
        CacheControl: this.cacheControl_,
        // NO ACL - this is the critical fix
      })

      await this.client_.send(command)

      const url = `https://${this.bucket_}.s3.${this.region_}.amazonaws.com/${key}`
      
      this.logger_.info(`File uploaded successfully: ${key}`)
      
      return { url, key }
    } catch (error) {
      this.logger_.error(`Error uploading file to S3: ${(error as any)?.message || String(error)}`)
      throw error
    }
  }

  async delete(fileData: { fileKey: string }): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket_,
        Key: fileData.fileKey,
      })

      await this.client_.send(command)
      this.logger_.info(`File deleted successfully: ${fileData.fileKey}`)
    } catch (error) {
      this.logger_.error(`Error deleting file from S3: ${(error as any)?.message || String(error)}`)
      throw error
    }
  }

  async getPresignedDownloadUrl(fileData: { fileKey: string }): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket_,
        Key: fileData.fileKey,
      })

      const url = await getSignedUrl(this.client_, command, { expiresIn: 3600 })
      return url
    } catch (error) {
      this.logger_.error(`Error generating presigned URL: ${(error as any)?.message || String(error)}`)
      throw error
    }
  }

  async getDownloadStream(fileData: { fileKey: string }): Promise<stream.Readable> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket_,
        Key: fileData.fileKey,
      })

      const response = await this.client_.send(command)
      return response.Body as stream.Readable
    } catch (error) {
      this.logger_.error(`Error getting download stream: ${(error as any)?.message || String(error)}`)
      throw error
    }
  }
}