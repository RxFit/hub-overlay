import { readFileSync } from 'fs'
const sql = readFileSync(process.argv[2], 'utf-8')
const copyIdx = sql.indexOf('COPY ')
if (copyIdx === -1) { console.log('No COPY found'); process.exit(1) }
console.log('=== First COPY block (800 chars) ===')
console.log(sql.substring(copyIdx, copyIdx + 800))
console.log('\n=== Searching for end marker ===')
const endMarker = sql.indexOf('\\.', copyIdx)
if (endMarker !== -1) {
  console.log(`Found \\. at position ${endMarker}`)
  console.log('Context around \\.:')
  console.log(JSON.stringify(sql.substring(endMarker - 50, endMarker + 20)))
} else {
  console.log('No \\. end marker found')
}
