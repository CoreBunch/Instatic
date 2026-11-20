import { describe, expect, it } from 'bun:test'
import { csvRecord, parseCsv } from './csv'

describe('member CSV', () => {
  it('quotes what needs quoting and guards spreadsheet formulas', () => {
    expect(csvRecord(['a', 'b,c', 'say "hi"', 'two\nlines'])).toBe('a,"b,c","say ""hi""","two\nlines"\r\n')
    expect(csvRecord(['=1+1', '+x', '-y', '@z', 'plain-name', '  =cmd'])).toBe("'=1+1,'+x,'-y,'@z,plain-name,'  =cmd\r\n")
    expect(parseCsv("a\n'  =cmd")?.[1].fields).toEqual(['  =cmd'])
  })

  it('reads back what it writes, with the line each record starts on', () => {
    const text = '﻿' + csvRecord(['email', 'name']) + csvRecord(['a@example.com', 'multi\nline "name"']) + '\r\n' + csvRecord(['b@example.com', '=SUM(A1)'])
    expect(parseCsv(text)).toEqual([
      { line: 1, fields: ['email', 'name'] },
      { line: 2, fields: ['a@example.com', 'multi\nline "name"'] },
      { line: 5, fields: ['b@example.com', '=SUM(A1)'] },
    ])
  })

  it('keeps a leading quote mark that is not a formula guard, and refuses an unclosed quote', () => {
    expect(parseCsv("email,name\na@example.com,'Tis me")?.[1].fields).toEqual(['a@example.com', "'Tis me"])
    expect(parseCsv('email\n"open')).toBeNull()
    expect(parseCsv('email\n\n\na@example.com\n')).toEqual([
      { line: 1, fields: ['email'] },
      { line: 4, fields: ['a@example.com'] },
    ])
  })
})
