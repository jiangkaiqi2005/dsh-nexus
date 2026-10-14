// Typert Host face of the Nexus call endpoint, read by the Host typert-loader.
// Written by hand in the shape the Typert generator emits, so the Gateway
// validates the browser's uplink strictly instead of using its SRC fallback.
// client.js mounts the matching Client descriptor; keep both in step.

const isAudio = value => typeof value === 'string' && value.length <= 1 << 20 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)

/** Client-to-Host item: captured microphone audio, base64 PCM16 16 kHz mono; or the samples played before a flush or hangup. */
const uplink = () => ({
  parse(value) {
    if (value?.type === 'ready' && Object.keys(value).length === 1) return value
    if (value && typeof value === 'object' && Object.keys(value).length === 2 && ((value.type === 'audio' && isAudio(value.audio)) || (['played', 'hangup'].includes(value.type) && Number.isSafeInteger(value.samples) && value.samples >= 0))) return value
    throw new TypeError('nexusVoice/call uplink must be { type: "audio", audio: base64 } or { type: "played" | "hangup", samples }')
  },
})

/** Host-to-client item: actual call state, model audio base64 PCM16 24 kHz mono, or a flush of queued playback. */
const frame = () => ({
  parse(value) {
    if (value?.type === 'audio' && isAudio(value.audio) && (value.replyId === undefined || typeof value.replyId === 'string')) return value
    if (value?.type === 'flush' && (value.replyId === undefined ? Object.keys(value).length === 1 : typeof value.replyId === 'string' && Object.keys(value).length === 2)) return value
    if (value?.type === 'activity' && ['thinking', 'reading', 'idle', 'failed'].includes(value.state) && (value.code === undefined || typeof value.code === 'string')) return value
    if (value?.type === 'state' && ['ready', 'connecting', 'live'].includes(value.state)) return value
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
    id: 'dsh-nexus#nexusVoice/claimStartup', service: 'nexusVoice', namespace: 'nexusVoice', method: 'claimStartup',
    invocation: { kind: 'direct' }, parameters: [],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'boolean', create: () => ({ parse(value) { if (typeof value === 'boolean') return value; throw new TypeError('startup claim must be boolean') } }) },
  }, {
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
