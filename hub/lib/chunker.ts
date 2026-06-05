export class RecursiveCharacterTextSplitter {
  private separators: string[]
  private chunkSize: number
  private chunkOverlap: number

  constructor(options?: { separators?: string[]; chunkSize?: number; chunkOverlap?: number }) {
    this.separators = options?.separators ?? ['\n\n', '\n', ' ', '']
    this.chunkSize = options?.chunkSize ?? 3000 // characters (~750 tokens)
    this.chunkOverlap = options?.chunkOverlap ?? 600 // characters (~150 tokens, 20% overlap)
  }

  /**
   * Splits the input text into semantic chunks based on configured separators, chunk size, and overlap.
   */
  splitText(text: string): string[] {
    return this._splitText(text, this.separators)
  }

  private _splitText(text: string, separators: string[]): string[] {
    if (text.length <= this.chunkSize) {
      return [text]
    }

    // Find the first separator that exists in the text
    let separator = separators[separators.length - 1]
    let nextSeparators: string[] = []

    for (let i = 0; i < separators.length; i++) {
      if (separators[i] === '' || text.includes(separators[i])) {
        separator = separators[i]
        nextSeparators = separators.slice(i + 1)
        break
      }
    }

    // Split text by the chosen separator
    const splits = separator === '' ? Array.from(text) : text.split(separator)

    const finalChunks: string[] = []
    let currentDoc: string[] = []
    let currentLength = 0

    for (const split of splits) {
      const splitText = split

      if (splitText.length > this.chunkSize) {
        // If a single split is larger than chunkSize, we must split it recursively
        if (currentDoc.length > 0) {
          finalChunks.push(this.joinDocs(currentDoc, separator))
          currentDoc = []
          currentLength = 0
        }

        const recursiveChunks = this._splitText(splitText, nextSeparators)
        for (const chunk of recursiveChunks) {
          finalChunks.push(chunk)
        }
      } else {
        const separatorLength = separator.length
        const prospectiveLength = currentLength + (currentLength > 0 ? separatorLength : 0) + splitText.length

        if (prospectiveLength > this.chunkSize) {
          // Flush currentDoc
          if (currentDoc.length > 0) {
            finalChunks.push(this.joinDocs(currentDoc, separator))
          }

          // Build overlap: keep elements from currentDoc until they fit within chunkOverlap
          const overlapDocs: string[] = []
          let overlapLength = 0
          for (let i = currentDoc.length - 1; i >= 0; i--) {
            const doc = currentDoc[i]
            const prospectiveOverlap = overlapLength + (overlapLength > 0 ? separatorLength : 0) + doc.length
            if (prospectiveOverlap <= this.chunkOverlap) {
              overlapDocs.unshift(doc)
              overlapLength = prospectiveOverlap
            } else {
              break
            }
          }

          currentDoc = overlapDocs
          currentLength = overlapLength
        }

        currentDoc.push(splitText)
        currentLength += (currentLength > 0 ? separator.length : 0) + splitText.length
      }
    }

    if (currentDoc.length > 0) {
      finalChunks.push(this.joinDocs(currentDoc, separator))
    }

    return finalChunks
  }

  private joinDocs(docs: string[], separator: string): string {
    return docs.join(separator).trim()
  }
}

/**
 * Convenience helper to semantically chunk a document.
 * 
 * @param text The document text to chunk
 * @param chunkSize Target maximum characters per chunk (default 3000 ~750 tokens)
 * @param chunkOverlap Target characters to overlap between chunks (default 600 ~150 tokens)
 */
export function semanticChunk(text: string, chunkSize: number = 3000, chunkOverlap: number = 600): string[] {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap })
  return splitter.splitText(text)
}
