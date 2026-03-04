// Browser-side WebAuthn helpers. Wraps the Credential Management API
// with base64url encoding/decoding to match the go-webauthn server.

function base64urlToBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const binary = atob(b64 + pad)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function bufferToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isWebAuthnAvailable(): boolean {
  return typeof window !== 'undefined' &&
    !!window.PublicKeyCredential &&
    typeof window.PublicKeyCredential === 'function'
}

// Start registration: calls navigator.credentials.create() and returns
// the response body to send to the server's finish endpoint.
export async function startRegistration(options: any): Promise<Response> {
  // Decode server-provided challenge and user.id from base64url
  const publicKey = options.publicKey
  publicKey.challenge = base64urlToBuffer(publicKey.challenge)
  publicKey.user.id = base64urlToBuffer(publicKey.user.id)
  if (publicKey.excludeCredentials) {
    for (const c of publicKey.excludeCredentials) {
      c.id = base64urlToBuffer(c.id)
    }
  }

  const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential
  const response = credential.response as AuthenticatorAttestationResponse

  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: bufferToBase64url(response.attestationObject),
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
    },
  } as any
}

// Start authentication: calls navigator.credentials.get() and returns
// the response body to send to the server's finish endpoint.
export async function startAuthentication(options: any): Promise<Response> {
  const publicKey = options.publicKey
  publicKey.challenge = base64urlToBuffer(publicKey.challenge)
  if (publicKey.allowCredentials) {
    for (const c of publicKey.allowCredentials) {
      c.id = base64urlToBuffer(c.id)
    }
  }

  const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential
  const response = credential.response as AuthenticatorAssertionResponse

  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bufferToBase64url(response.authenticatorData),
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : undefined,
    },
  } as any
}
