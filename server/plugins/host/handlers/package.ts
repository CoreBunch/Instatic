import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isPathWithin } from '../../../util/pathWithin'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

export async function handlePackageRead(msg: ApiCallFor<'cms.package.read'>, entry: HostPluginRecord) {
  const [path, offset, length] = msg.args
  try {
    const data = join(await realpath(entry.assetRootPath), 'data')
    const filePath = await realpath(join(data, path))
    if (!isPathWithin(data, filePath)) throw new Error('Outside package data')
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) throw new Error('Expected a regular package file')
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      replyApiOk(msg.pluginId, msg.correlationId, buffer.toString('base64', 0, bytesRead))
    } finally {
      await file.close()
    }
  } catch (cause) {
    throw new Error('Could not read the requested package data file', { cause })
  }
}
