/**
 * test-rxharden-email-workflow.ts
 * 
 * Simulates the RxHarden Test Email workflow for Paperclip Agents
 * defined in google-workspace-integration.md.
 * 
 * Run with: npx tsx test-rxharden-email-workflow.ts
 */

const GREEN = '\x1b[32m'
const BLUE = '\x1b[34m'
const RESET = '\x1b[0m'
const YELLOW = '\x1b[33m'

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runSimulation() {
  console.log(`${BLUE}=== Starting RxHarden Test Email Workflow Simulation ===${RESET}\n`)

  const issueId = 'issue-882'
  const adminEmail = 'admin@rxfitatx.com'
  const clientEmail = 'client@example.com'
  
  console.log(`[Agent] Picked up Issue ${issueId}: "Send proposal to ${clientEmail}"`)
  await sleep(1000)

  console.log(`[Agent] Retrieving GOOGLE_WORKSPACE_SERVICE_ACCOUNT from Paperclip Secrets...`)
  // Mocking the secret retrieval
  const mockSecret = { client_email: 'ai@rxfitatx.com', private_key: '-----BEGIN PRIVATE KEY-----...' }
  await sleep(500)
  console.log(`[Agent] ✅ Authenticated as Service Account: ${GREEN}${mockSecret.client_email}${RESET}\n`)

  console.log(`[Agent] Drafting email...`)
  const draftSubject = 'RxFit Corporate Wellness Proposal'
  const draftBody = 'Hi there, attached is our wellness proposal...'
  await sleep(800)

  // 1. Send Test Email to Admin
  console.log(`${YELLOW}>> Policy Triggered: External email detected. Enforcing RxHarden Test Email Workflow. <<${RESET}`)
  console.log(`[Agent] Sending TEST draft to Admin (${adminEmail})...`)
  const testEmailPayload = {
    to: adminEmail,
    subject: `[TEST DRAFT] ${draftSubject}`,
    body: draftBody
  }
  console.dir(testEmailPayload, { depth: null, colors: true })
  await sleep(1000)
  console.log(`[Agent] ✅ Test email sent via Google Workspace API.\n`)

  // 2. Post to Issue Thread
  console.log(`[Agent] Posting approval request to Paperclip Issue Thread...`)
  const threadMessage = `I have drafted the email to ${clientEmail} and sent a test copy to your inbox. Please review it in the Hub's Gmail tab. Reply 'Approved' here if I should send it.`
  console.log(`${BLUE}Message: "${threadMessage}"${RESET}\n`)
  await sleep(1500)

  // 3. Human interaction
  console.log(`[Human] *Logs into Hub*`)
  console.log(`[Human] *Opens GoogleChatPanel -> Gmail View*`)
  console.log(`[Human] *Reads test email from ai@rxfitatx.com*`)
  console.log(`[Human] *Replies in Paperclip Issue Thread: "Approved"* \n`)
  await sleep(1500)

  // 4. Send Final Email
  console.log(`[Agent] Received approval from ${adminEmail}.`)
  console.log(`[Agent] Sending FINAL email to Client (${clientEmail})...`)
  const finalEmailPayload = {
    to: clientEmail,
    subject: draftSubject,
    body: draftBody
  }
  console.dir(finalEmailPayload, { depth: null, colors: true })
  await sleep(1000)
  console.log(`[Agent] ✅ Final email sent successfully. Workflow complete.\n`)
}

runSimulation().catch(console.error)
