/**
 * Stored ZIP64 streaming helpers.
 *
 * Site-transfer archives intentionally store entries without compression:
 * media files are often already compressed, and stored entries let export stream
 * bytes directly without buffering the archive in memory. ZIP64 is emitted
 * whenever an entry, central directory, offset, or file count needs it.
 */

import { createReadStream } from 'node:fs'
import { crc32 } from 'node:zlib'

const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50
const ZIP_DATA_DESCRIPTOR = 0x08074b50
const ZIP64_EXTRA_FIELD_ID = 0x0001
const ZIP_UTF8_FLAG = 0x0800
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008
const ZIP_STORED_METHOD = 0
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff
const ZIP_VERSION_STORED = 20
const ZIP_VERSION_ZIP64 = 45
const STREAM_CHUNK_BYTES = 1024 * 1024

const encoder = new TextEncoder()

export interface StoredZipEntrySize {
  path: string
  sizeBytes: number
  usesDataDescriptor?: boolean
}

export interface StoredZipEntry extends StoredZipEntrySize {
  source: Uint8Array | string
}

interface CentralDirectoryEntry {
  pathBytes: Uint8Array
  sizeBytes: number
  crc32: number
  localHeaderOffset: number
  usesZip64Sizes: boolean
  usesDataDescriptor: boolean
}

export function createStoredZipStream(entries: readonly StoredZipEntry[]): ReadableStream<Uint8Array> {
  return readableFromAsyncGenerator(streamStoredZip(entries))
}

export function estimateStoredZipSize(entries: readonly StoredZipEntrySize[]): number {
  let offset = 0
  const centralEntries: CentralDirectoryEntry[] = []

  for (const entry of entries) {
    assertZipEntry(entry)
    const pathBytes = encodePath(entry.path)
    const usesZip64Sizes = entry.sizeBytes > UINT32_MAX
    const usesDataDescriptor = entry.usesDataDescriptor ?? true
    const localHeaderSize = 30 + pathBytes.byteLength + localZip64ExtraLength(usesZip64Sizes)
    const descriptorSize = usesDataDescriptor ? dataDescriptorLength(usesZip64Sizes) : 0
    centralEntries.push({
      pathBytes,
      sizeBytes: entry.sizeBytes,
      crc32: 0,
      localHeaderOffset: offset,
      usesZip64Sizes,
      usesDataDescriptor,
    })
    offset += localHeaderSize + entry.sizeBytes + descriptorSize
  }

  const centralDirectoryOffset = offset
  let centralDirectorySize = 0
  for (const entry of centralEntries) {
    centralDirectorySize += centralDirectoryEntryLength(entry)
  }
  offset += centralDirectorySize

  const needsZip64End =
    centralEntries.length > UINT16_MAX ||
    centralDirectoryOffset > UINT32_MAX ||
    centralDirectorySize > UINT32_MAX ||
    centralEntries.some((entry) => entry.usesZip64Sizes || entry.localHeaderOffset > UINT32_MAX)

  if (needsZip64End) {
    offset += 56 + 20
  }
  offset += 22
  return offset
}

async function* streamStoredZip(entries: readonly StoredZipEntry[]): AsyncGenerator<Uint8Array> {
  let offset = 0
  const centralEntries: CentralDirectoryEntry[] = []

  for (const entry of entries) {
    assertZipEntry(entry)
    const pathBytes = encodePath(entry.path)
    const usesZip64Sizes = entry.sizeBytes > UINT32_MAX
    const usesDataDescriptor = typeof entry.source === 'string'
    const precomputedCrc = typeof entry.source === 'string' ? 0 : crc32Of(entry.source)
    const localHeader = makeLocalFileHeader(
      entry,
      pathBytes,
      usesZip64Sizes,
      usesDataDescriptor,
      precomputedCrc,
    )
    yield localHeader
    const localHeaderOffset = offset
    offset += localHeader.byteLength

    const crc = createCrc32()
    let written = 0
    for await (const chunk of entryChunks(entry.source)) {
      crc.update(chunk)
      written += chunk.byteLength
      if (written > entry.sizeBytes) {
        throw new Error(`ZIP entry "${entry.path}" exceeded its declared size`)
      }
      offset += chunk.byteLength
      yield chunk
    }
    if (written !== entry.sizeBytes) {
      throw new Error(`ZIP entry "${entry.path}" wrote ${written} bytes, expected ${entry.sizeBytes}`)
    }

    const crc32 = crc.digest()
    if (usesDataDescriptor) {
      const descriptor = makeDataDescriptor(crc32, written, usesZip64Sizes)
      yield descriptor
      offset += descriptor.byteLength
    }

    centralEntries.push({
      pathBytes,
      sizeBytes: written,
      crc32,
      localHeaderOffset,
      usesZip64Sizes,
      usesDataDescriptor,
    })
  }

  const centralDirectoryOffset = offset
  const centralChunks = centralEntries.map(makeCentralDirectoryHeader)
  const centralDirectorySize = centralChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  for (const chunk of centralChunks) {
    yield chunk
    offset += chunk.byteLength
  }

  const needsZip64End =
    centralEntries.length > UINT16_MAX ||
    centralDirectoryOffset > UINT32_MAX ||
    centralDirectorySize > UINT32_MAX ||
    centralEntries.some((entry) => entry.usesZip64Sizes || entry.localHeaderOffset > UINT32_MAX)

  if (needsZip64End) {
    const zip64End = makeZip64EndOfCentralDirectory(
      centralEntries.length,
      centralDirectorySize,
      centralDirectoryOffset,
    )
    yield zip64End
    const zip64EndOffset = offset

    const locator = makeZip64Locator(zip64EndOffset)
    yield locator
  }

  yield makeEndOfCentralDirectory(
    centralEntries.length,
    centralDirectorySize,
    centralDirectoryOffset,
    needsZip64End,
  )
}

function readableFromAsyncGenerator(generator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await generator.next()
      if (next.done) {
        controller.close()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel() {
      await generator.return(undefined).catch(() => {})
    },
  })
}

async function* entryChunks(source: Uint8Array | string): AsyncGenerator<Uint8Array> {
  if (typeof source !== 'string') {
    yield source
    return
  }

  for await (const chunk of createReadStream(source, { highWaterMark: STREAM_CHUNK_BYTES })) {
    yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)
  }
}

function makeLocalFileHeader(
  entry: StoredZipEntrySize,
  pathBytes: Uint8Array,
  usesZip64Sizes: boolean,
  usesDataDescriptor: boolean,
  crc32: number,
): Uint8Array {
  const extra = usesZip64Sizes ? makeZip64Extra([entry.sizeBytes, entry.sizeBytes]) : new Uint8Array(0)
  const header = new Uint8Array(30 + pathBytes.byteLength + extra.byteLength)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)

  writeUint32(view, 0, ZIP_LOCAL_FILE_HEADER)
  writeUint16(view, 4, usesZip64Sizes ? ZIP_VERSION_ZIP64 : ZIP_VERSION_STORED)
  writeUint16(view, 6, ZIP_UTF8_FLAG | (usesDataDescriptor ? ZIP_DATA_DESCRIPTOR_FLAG : 0))
  writeUint16(view, 8, ZIP_STORED_METHOD)
  writeDosDateTime(view, 10)
  writeUint32(view, 14, usesDataDescriptor ? 0 : crc32)
  writeUint32(view, 18, usesZip64Sizes ? UINT32_MAX : (usesDataDescriptor ? 0 : entry.sizeBytes))
  writeUint32(view, 22, usesZip64Sizes ? UINT32_MAX : (usesDataDescriptor ? 0 : entry.sizeBytes))
  writeUint16(view, 26, pathBytes.byteLength)
  writeUint16(view, 28, extra.byteLength)
  header.set(pathBytes, 30)
  header.set(extra, 30 + pathBytes.byteLength)

  return header
}

function makeDataDescriptor(crc32: number, sizeBytes: number, usesZip64Sizes: boolean): Uint8Array {
  const descriptor = new Uint8Array(usesZip64Sizes ? 24 : 16)
  const view = new DataView(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength)
  writeUint32(view, 0, ZIP_DATA_DESCRIPTOR)
  writeUint32(view, 4, crc32)
  if (usesZip64Sizes) {
    writeUint64(view, 8, sizeBytes)
    writeUint64(view, 16, sizeBytes)
  } else {
    writeUint32(view, 8, sizeBytes)
    writeUint32(view, 12, sizeBytes)
  }
  return descriptor
}

function makeCentralDirectoryHeader(entry: CentralDirectoryEntry): Uint8Array {
  const extra = makeCentralZip64Extra(entry)
  const header = new Uint8Array(46 + entry.pathBytes.byteLength + extra.byteLength)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const usesZip64 = entry.usesZip64Sizes || entry.localHeaderOffset > UINT32_MAX

  writeUint32(view, 0, ZIP_CENTRAL_DIRECTORY_HEADER)
  writeUint16(view, 4, usesZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_STORED)
  writeUint16(view, 6, usesZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_STORED)
  writeUint16(view, 8, ZIP_UTF8_FLAG | (entry.usesDataDescriptor ? ZIP_DATA_DESCRIPTOR_FLAG : 0))
  writeUint16(view, 10, ZIP_STORED_METHOD)
  writeDosDateTime(view, 12)
  writeUint32(view, 16, entry.crc32)
  writeUint32(view, 20, entry.usesZip64Sizes ? UINT32_MAX : entry.sizeBytes)
  writeUint32(view, 24, entry.usesZip64Sizes ? UINT32_MAX : entry.sizeBytes)
  writeUint16(view, 28, entry.pathBytes.byteLength)
  writeUint16(view, 30, extra.byteLength)
  writeUint16(view, 32, 0)
  writeUint16(view, 34, 0)
  writeUint16(view, 36, 0)
  writeUint32(view, 38, 0)
  writeUint32(view, 42, entry.localHeaderOffset > UINT32_MAX ? UINT32_MAX : entry.localHeaderOffset)
  header.set(entry.pathBytes, 46)
  header.set(extra, 46 + entry.pathBytes.byteLength)

  return header
}

function makeZip64EndOfCentralDirectory(
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number,
): Uint8Array {
  const record = new Uint8Array(56)
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength)
  writeUint32(view, 0, ZIP64_END_OF_CENTRAL_DIRECTORY)
  writeUint64(view, 4, 44)
  writeUint16(view, 12, ZIP_VERSION_ZIP64)
  writeUint16(view, 14, ZIP_VERSION_ZIP64)
  writeUint32(view, 16, 0)
  writeUint32(view, 20, 0)
  writeUint64(view, 24, entryCount)
  writeUint64(view, 32, entryCount)
  writeUint64(view, 40, centralDirectorySize)
  writeUint64(view, 48, centralDirectoryOffset)
  return record
}

function makeZip64Locator(zip64EndOffset: number): Uint8Array {
  const locator = new Uint8Array(20)
  const view = new DataView(locator.buffer, locator.byteOffset, locator.byteLength)
  writeUint32(view, 0, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR)
  writeUint32(view, 4, 0)
  writeUint64(view, 8, zip64EndOffset)
  writeUint32(view, 16, 1)
  return locator
}

function makeEndOfCentralDirectory(
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number,
  usesZip64: boolean,
): Uint8Array {
  const record = new Uint8Array(22)
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength)
  writeUint32(view, 0, ZIP_END_OF_CENTRAL_DIRECTORY)
  writeUint16(view, 4, 0)
  writeUint16(view, 6, 0)
  writeUint16(view, 8, usesZip64 ? UINT16_MAX : entryCount)
  writeUint16(view, 10, usesZip64 ? UINT16_MAX : entryCount)
  writeUint32(view, 12, usesZip64 ? UINT32_MAX : centralDirectorySize)
  writeUint32(view, 16, usesZip64 ? UINT32_MAX : centralDirectoryOffset)
  writeUint16(view, 20, 0)
  return record
}

function centralDirectoryEntryLength(entry: CentralDirectoryEntry): number {
  return 46 + entry.pathBytes.byteLength + centralZip64ExtraLength(entry)
}

function localZip64ExtraLength(usesZip64Sizes: boolean): number {
  return usesZip64Sizes ? 4 + 16 : 0
}

function dataDescriptorLength(usesZip64Sizes: boolean): number {
  return usesZip64Sizes ? 24 : 16
}

function centralZip64ExtraLength(entry: CentralDirectoryEntry): number {
  let valueCount = 0
  if (entry.usesZip64Sizes) valueCount += 2
  if (entry.localHeaderOffset > UINT32_MAX) valueCount++
  return valueCount > 0 ? 4 + (valueCount * 8) : 0
}

function makeCentralZip64Extra(entry: CentralDirectoryEntry): Uint8Array {
  const values: number[] = []
  if (entry.usesZip64Sizes) values.push(entry.sizeBytes, entry.sizeBytes)
  if (entry.localHeaderOffset > UINT32_MAX) values.push(entry.localHeaderOffset)
  return makeZip64Extra(values)
}

function makeZip64Extra(values: readonly number[]): Uint8Array {
  if (values.length === 0) return new Uint8Array(0)
  const extra = new Uint8Array(4 + (values.length * 8))
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  writeUint16(view, 0, ZIP64_EXTRA_FIELD_ID)
  writeUint16(view, 2, values.length * 8)
  values.forEach((value, index) => {
    writeUint64(view, 4 + (index * 8), value)
  })
  return extra
}

function encodePath(path: string): Uint8Array {
  const pathBytes = encoder.encode(path)
  if (pathBytes.byteLength > UINT16_MAX) {
    throw new Error(`ZIP entry path is too long: ${path}`)
  }
  return pathBytes
}

function assertZipEntry(entry: StoredZipEntrySize): void {
  if (!entry.path || entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
    throw new Error(`Unsafe ZIP entry path: ${entry.path}`)
  }
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    throw new Error(`Invalid ZIP entry size for "${entry.path}": ${entry.sizeBytes}`)
  }
}

function writeDosDateTime(view: DataView, offset: number): void {
  writeUint16(view, offset, 0)
  writeUint16(view, offset + 2, 0x0021)
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true)
}

function writeUint64(view: DataView, offset: number, value: number): void {
  view.setBigUint64(offset, BigInt(value), true)
}

/**
 * Streaming CRC-32 over `node:zlib`'s native implementation. `crc32(buf, prev)`
 * seeds from a previous result, which is exactly the chained-chunk contract the
 * ZIP writer needs.
 */
export function createCrc32() {
  let value = 0
  return {
    update(bytes: Uint8Array) {
      value = crc32(bytes, value)
    },
    digest() {
      return value >>> 0
    },
  }
}

function crc32Of(bytes: Uint8Array): number {
  return crc32(bytes) >>> 0
}
