import S3NoACLFileService from "./services/s3-no-acl"
import { ModuleProvider, Modules } from "@medusajs/framework/utils"

export default ModuleProvider(Modules.FILE, {
  services: [S3NoACLFileService],
})