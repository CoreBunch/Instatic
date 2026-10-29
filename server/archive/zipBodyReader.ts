/** Incremental stored-ZIP reader with ZIP64 and streamed CRC descriptor validation. */
const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50
const ZIP_DATA_DESCRIPTOR = 0x08074b50
const ZIP64_EXTRA_FIELD_ID = 0x0001
const UINT32_MAX = 0xffffffff

const textDecoder = new TextDecoder()

interface LocalHeader {
  path: string
  flags: number
  compression: number
  crc32: number
  compressedSize: number | null
  uncompressedSize: number | null
}

export class ZipBodyReader {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private ended = false
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader
  }

  async readLocalHeader(): Promise<LocalHeader | null> {
    const signatureBytes = await this.readExact(4)
    if (!signatureBytes) return null
    const signature = readUint32(signatureBytes, 0)
    if (
      signature === ZIP_CENTRAL_DIRECTORY_HEADER ||
      signature === ZIP_END_OF_CENTRAL_DIRECTORY ||
      signature === ZIP64_END_OF_CENTRAL_DIRECTORY ||
      signature === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR
    ) {
      return null
    }
    if (signature !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error('Invalid ZIP local file header in CMS bundle archive')
    }

    const rest = await this.readExact(26)
    if (!rest) throw new Error('Truncated ZIP local file header')
    const flags = readUint16(rest, 2)
    const compression = readUint16(rest, 4)
    const compressedSize32 = readUint32(rest, 14)
    const uncompressedSize32 = readUint32(rest, 18)
    const fileNameLength = readUint16(rest, 22)
    const extraLength = readUint16(rest, 24)
    const metadata = await this.readExact(fileNameLength + extraLength)
    if (!metadata) throw new Error('Truncated ZIP local file metadata')

    const path = textDecoder.decode(metadata.subarray(0, fileNameLength))
    const extra = metadata.subarray(fileNameLength)
    const zip64Sizes = compressedSize32 === UINT32_MAX || uncompressedSize32 === UINT32_MAX
      ? readZip64LocalSizes(extra)
      : null

    return {
      path,
      flags,
      compression,
      crc32: readUint32(rest, 10),
      compressedSize: compressedSize32 === UINT32_MAX ? zip64Sizes?.compressedSize ?? null : compressedSize32,
      uncompressedSize: uncompressedSize32 === UINT32_MAX ? zip64Sizes?.uncompressedSize ?? null : uncompressedSize32,
    }
  }

  async readExact(size: number): Promise<Uint8Array<ArrayBufferLike> | null> {
    if (size === 0) return new Uint8Array(0)
    while (this.pending.byteLength < size && !this.ended) {
      const next = await this.reader.read()
      if (next.done) {
        this.ended = true
        break
      }
      const merged = new Uint8Array(this.pending.byteLength + next.value.byteLength)
      merged.set(this.pending, 0)
      merged.set(next.value, this.pending.byteLength)
      this.pending = merged
    }
    if (this.pending.byteLength === 0 && this.ended) return null
    if (this.pending.byteLength < size) throw new Error('CMS bundle archive ended unexpectedly')
    const out = this.pending.slice(0, size)
    this.pending = this.pending.slice(size)
    return out
  }

  async copyExact(
    size: number,
    writeChunk: (chunk: Uint8Array<ArrayBufferLike>) => Promise<void>,
  ): Promise<void> {
    let remaining = size
    while (remaining > 0) {
      if (this.pending.byteLength === 0) {
        const next = await this.reader.read()
        if (next.done) throw new Error('CMS bundle archive media entry is truncated')
        this.pending = next.value
      }
      const chunkSize = Math.min(remaining, this.pending.byteLength)
      const chunk = this.pending.subarray(0, chunkSize)
      await writeChunk(chunk)
      this.pending = this.pending.subarray(chunkSize)
      remaining -= chunkSize
    }
  }

  async readAndValidateDataDescriptor(expected: { crc32: number; sizeBytes: number }): Promise<void> {
    const descriptorSize = expected.sizeBytes > UINT32_MAX ? 24 : 16
    const descriptor = await this.readExact(descriptorSize)
    if (!descriptor) throw new Error('CMS bundle archive media descriptor is missing')
    if (readUint32(descriptor, 0) !== ZIP_DATA_DESCRIPTOR) {
      throw new Error('CMS bundle archive media descriptor is invalid')
    }
    const actualCrc = readUint32(descriptor, 4)
    const actualCompressedSize = expected.sizeBytes > UINT32_MAX
      ? Number(readUint64(descriptor, 8))
      : readUint32(descriptor, 8)
    const actualUncompressedSize = expected.sizeBytes > UINT32_MAX
      ? Number(readUint64(descriptor, 16))
      : readUint32(descriptor, 12)
    if (
      actualCrc !== expected.crc32 ||
      actualCompressedSize !== expected.sizeBytes ||
      actualUncompressedSize !== expected.sizeBytes
    ) {
      throw new Error('CMS bundle archive media descriptor does not match the streamed bytes')
    }
  }
}

function readZip64LocalSizes(extra: Uint8Array): { uncompressedSize: number; compressedSize: number } | null {
  let offset = 0
  while (offset + 4 <= extra.byteLength) {
    const headerId = readUint16(extra, offset)
    const dataSize = readUint16(extra, offset + 2)
    const dataStart = offset + 4
    const dataEnd = dataStart + dataSize
    if (dataEnd > extra.byteLength) return null
    if (headerId === ZIP64_EXTRA_FIELD_ID) {
      if (dataSize < 16) return null
      return {
        uncompressedSize: Number(readUint64(extra, dataStart)),
        compressedSize: Number(readUint64(extra, dataStart + 8)),
      }
    }
    offset = dataEnd
  }
  return null
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true)
}
