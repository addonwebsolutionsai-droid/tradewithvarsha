import fs from 'fs/promises'
import path from 'path'

const ERRORS_MD = path.resolve(__dirname, '../../../.claude/ERRORS.md')

export interface IssueRecord {
  severity: 'LOW' | 'MED' | 'HIGH' | 'CRITICAL'
  description: string
  rootCause?: string
  fixApplied?: string
  verified?: boolean
}

export async function logIssue(rec: IssueRecord): Promise<void> {
  try {
    const ts = new Date().toISOString()
    const line = `| ${ts.slice(0, 10)} | ${rec.description} | ${rec.rootCause ?? '—'} | ${rec.fixApplied ?? 'pending'} | ${rec.verified ? '✅' : '⏳'} |\n`
    const existing = await fs.readFile(ERRORS_MD, 'utf8').catch(() => '')
    // Append under the Resolved Issues Log table
    const marker = '| Date | Issue | Root Cause | Fix Applied | Verified |\n'
    if (existing.includes(marker)) {
      const idx = existing.indexOf(marker) + marker.length
      const next = existing.indexOf('\n\n', idx)
      const insertAt = next === -1 ? existing.length : next
      const updated = existing.slice(0, insertAt) + line + existing.slice(insertAt)
      await fs.writeFile(ERRORS_MD, updated, 'utf8')
    } else {
      await fs.appendFile(ERRORS_MD, `\n${line}`, 'utf8')
    }
  } catch {
    // swallow — logging failures shouldn't crash the server
  }
}
