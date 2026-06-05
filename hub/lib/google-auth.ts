import crypto from 'crypto'

interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri: string
}

/**
 * Retrieve a Google access token using the GCP service account key from environment.
 * 
 * @param scope Google API scope (e.g. 'https://www.googleapis.com/auth/drive.readonly')
 * @returns Access token or null if auth fails
 */
export async function getServiceAccountAccessToken(scope: string): Promise<string | null> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) {
    console.warn('[google-auth] GOOGLE_SERVICE_ACCOUNT_KEY is not set')
    return null
  }

  try {
    const key: ServiceAccountKey = JSON.parse(keyJson)

    // Build JWT Header and Claim Set
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const claimSet = {
      iss: key.client_email,
      scope,
      aud: key.token_uri,
      iat: now,
      exp: now + 3600,
    }
    const payload = Buffer.from(JSON.stringify(claimSet)).toString('base64url')

    // Sign JWT using private key
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    const signature = signer.sign(key.private_key, 'base64url')
    const jwt = `${header}.${payload}.${signature}`

    // Exchange JWT for access token
    const res = await fetch(key.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[google-auth] Token exchange failed:', res.status, body)
      return null
    }

    const data = await res.json() as { access_token: string }
    return data.access_token
  } catch (err) {
    console.error('[google-auth] Service account auth error:', err)
    return null
  }
}
