import { google, sheets_v4 } from 'googleapis'
import * as _ from 'lodash'
import { Errors } from './errors'
import { Query, Document } from './types'
import * as bluebird from 'bluebird'

export interface IStorage {
  insert(docs: Document[]): Promise<Document[]>
  find(query?: Query): Promise<Document[]>
  update(
    query: Query,
    toUpdate: Partial<Document>,
    opts?: { updatedOnce: boolean },
  ): Promise<Document[]>
  remove(query: Query): Promise<Document[]>
  load(): Promise<void>
}

export interface IStorageOptions {
  db: string // google spreadsheet id
  table?: string
  apiKey?: string
  keyFile?: string
}

export default class GoogleStorage implements IStorage {
  private sheets: sheets_v4.Sheets
  private db: string
  private table: string
  private schema: { name: string }[] = []
  private schemaMetaStore: { [name: string]: { col: number } } = {}
  private data: string[][] = new Array()
  private lastUpdated: Date | null = null

  constructor(opts: IStorageOptions) {
    this.sheets = google.sheets({
      version: 'v4',
      auth: opts.apiKey
        ? opts.apiKey
        : new google.auth.GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            keyFile: opts.keyFile,
          }),
    })
    this.db = opts.db
    this.table = opts.table || 'Sheet1'
  }

  _findRows(query?: Query): number[] {
    const rowNums = _.map(this.data, (row, rowNum) => {
      if (!query || !_.keys(query).length) {
        return rowNum
      }

      for (let colNum = 0; colNum < row.length; ++colNum) {
        const field = row[colNum]
        const fieldName = this.schema[colNum].name
        if (query[fieldName] && _.toString(field) !== query[fieldName]) {
          return null
        }
      }
      return rowNum
    })

    return _.compact(rowNums)
  }

  _rowToDoc = (row: string[]): Document => {
    const doc: Document = {}
    for (let colNum = 0; colNum < row.length; ++colNum) {
      const field = row[colNum]
      const fieldName = this.schema[colNum].name
      doc[fieldName] = _.toString(field)
    }
    return doc
  }

  _docToRow = (doc: Document): string[] => {
    const row = new Array(this.schema.length)
    for (const fieldName of _.keys(doc)) {
      row[this.schemaMetaStore[fieldName].col] = _.toString(doc[fieldName])
    }
    return row
  }

  async find(query?: Query): Promise<Document[]> {
    await this._syncData()

    const rowNums = this._findRows(query)
    const docs = _.map(rowNums, (rowNum) => this._rowToDoc(this.data[rowNum]))
    return docs
  }

  async insert(docs: Document[]): Promise<Document[]> {
    await this._syncData()

    const rows = _.map(docs, this._docToRow)

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.db,
      range: this.table,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: rows,
      },
    })
    this.data.push(...rows)

    return _.map(rows, this._rowToDoc)
  }

  async update(
    query: Query,
    toUpdate: Document,
    opts: { updatedOnce: boolean } = { updatedOnce: false },
  ): Promise<Document[]> {
    await this._syncData()

    const rowNums = this._findRows(query)
    const { updatedOnce } = opts
    if (!rowNums.length) {
      return []
    }

    const docs: Document[] = []
    await bluebird.map(
      updatedOnce ? [rowNums[0]] : rowNums,
      async (rowNum) => {
        const oldDoc = this._rowToDoc(this.data[rowNum])
        const newDoc = { ...oldDoc, ...toUpdate }
        const row = this._docToRow(newDoc)

        docs.push(this._rowToDoc(row))

        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.db,
          range: `A${rowNum + 2}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [row],
          },
        })
        this.data[rowNum] = row
      },
      { concurrency: 10 },
    )

    return docs
  }

  async remove(query: Query): Promise<Document[]> {
    await this._syncData()

    const rowNums = this._findRows(query)
    const emptyDoc = _.mapValues(this.schemaMetaStore, () => '')
    const emptyRow = this._docToRow(emptyDoc)
    const oldDoc: Document[] = []
    await bluebird.map(
      rowNums,
      async (rowNum) => {
        oldDoc.push(this._rowToDoc(this.data[rowNum]))

        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.db,
          range: `A${rowNum + 2}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [emptyRow],
          },
        })
        this.data[rowNum] = emptyRow
      },
      { concurrency: 10 },
    )

    return oldDoc
  }

  async _syncData(): Promise<boolean> {
    if (!this.lastUpdated || Date.now() - this.lastUpdated.getTime() >= 5000) {
      await this.load()
      return true
    }
    return false
  }

  async load() {
    const res = await this.sheets.spreadsheets.values.get({
      range: this.table,
      spreadsheetId: this.db,
    })
    const rows = res.data.values
    if (!rows || rows.length === 0) {
      throw new Errors.StorageFormatError()
    }

    const schema = new Array(rows[0].length)
    const schemaMetaStore: { [key: string]: { col: number } } = {}
    for (let colNum = 0; colNum < rows[0].length; ++colNum) {
      schema[colNum] = {
        name: rows[0][colNum],
      }
      schemaMetaStore[rows[0][colNum]] = { col: colNum }
    }

    this.schema = schema
    this.schemaMetaStore = schemaMetaStore
    this.data = _.slice(rows, 1)
  }
}