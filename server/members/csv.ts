/**
 * CSV for the member export and import (RFC 4180: comma separated, fields
 * quoted with `"` when they hold a comma, quote or line break, `""` for a
 * quote inside one, CRLF between records).
 *
 * A field a spreadsheet would read as a formula (starting with `=`, `+`,
 * `-`, `@`, a tab or a carriage return) is written with a leading `'`, so
 * opening an export cannot run anything a member typed into their name.
 * Reading takes that `'` off again, so an export imports as it was.
 */

const FORMULA_START = /^[=+\-@\t\r]/

/** One field, made safe for a spreadsheet and quoted when it needs to be. */
function encodeField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** One record, with its CRLF. */
export function csvRecord(fields: readonly string[]): string {
  return `${fields.map(encodeField).join(',')}\r\n`
}

/** Undo the formula guard `encodeField` adds. */
function decodeField(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value
}

export interface CsvRow {
  /** The line the record starts on, from 1. */
  line: number
  fields: string[]
}

/**
 * Every record of a CSV text. A byte-order mark is dropped, and so are
 * blank lines. Null when a quoted field is never closed.
 */
export function parseCsv(text: string): CsvRow[] | null {
  const source = text.startsWith('﻿') ? text.slice(1) : text
  const rows: CsvRow[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let recordLine = 1
  let fieldStarted = false

  const endRecord = () => {
    if (fieldStarted || fields.length > 0 || field !== '') {
      fields.push(decodeField(field))
      if (!(fields.length === 1 && fields[0] === '')) rows.push({ line: recordLine, fields })
    }
    fields = []
    field = ''
    fieldStarted = false
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else {
        if (char === '\n') line++
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      fieldStarted = true
    } else if (char === ',') {
      fields.push(decodeField(field))
      field = ''
      fieldStarted = true
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i++
      endRecord()
      line++
      recordLine = line
    } else {
      field += char
      fieldStarted = true
    }
  }
  if (quoted) return null
  endRecord()
  return rows
}
