// Typert Host face of the Nexus call endpoint, read by the Host typert-loader.
// Written by hand in the shape the Typert generator emits, so the Gateway
// validates the browser's uplink strictly instead of using its SRC fallback.
// client.js mounts the matching Client descriptor; keep both in step.

const isAudio = value => typeof value === 'string' && value.length <= 1 << 20 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)

/** Client-to-Host item: captured microphone audio, base64 PCM16 16 kHz mono. */
const uplink = () => ({
  parse(value) {
    if (!value || typeof value !== 'object' || value.type !== 'audio' || !isAudio(value.audio) || Object.keys(value).length !== 2) throw new TypeError('nexusVoice/call uplink must be { type: "audio", audio: base64 }')
    return value
  },
})

/** Host-to-client item: actual call state, or model audio base64 PCM16 24 kHz mono. */
const frame = () => ({
  parse(value) {
    if (value?.type === 'audio' && isAudio(value.audio)) return value
    if (value?.type === 'state' && ['connecting', 'live'].includes(value.state)) return value
    if (value?.type === 'state' && value.state === 'failed' && typeof value.code === 'string') return value
    throw new TypeError('nexusVoice/call frame is malformed')
  },
})

export const TYPERT = {
  package: 'dsh-nexus',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [{
    id: 'dsh-nexus#nexusVoice/call',
    service: 'nexusVoice',
    namespace: 'nexusVoice',
    method: 'call',
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters: [],
    uplink: { codec: { mode: 'strict', typeSymbol: 'dsh-nexus/voice#VoiceUplink', create: uplink } },
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-nexus/voice#VoiceFrame', create: frame },
  }],
}
