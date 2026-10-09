import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const RATE = 16000

/** Synthesize one utterance offline with Windows SAPI (hidden window) as 16 kHz mono PCM16 WAV. */
async function synthesize(text, voice, path) {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SelectVoice('${voice}')`,
    `$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
    `$s.SetOutputToWaveFile('${path.replace(/'/g, "''")}', $f)`,
    `$s.Speak([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}')))`,
    '$s.Dispose()',
  ].join('; ')
  await new Promise((accept, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? accept() : reject(new Error(`SAPI synthesis exited ${code}`)))
  })
}

function pcmOf(wav) {
  let offset = 12
  while (offset < wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      if (wav.readUInt16LE(offset + 8) !== 1 || wav.readUInt16LE(offset + 10) !== 1 || wav.readUInt32LE(offset + 12) !== RATE || wav.readUInt16LE(offset + 22) !== 16) throw new Error('unexpected synthesized WAV format')
    }
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size & 1)
  }
  throw new Error('WAV has no data chunk')
}

function wavOf(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const silence = seconds => Buffer.alloc(Math.round(seconds * RATE) * 2)

/**
 * Build one capture file: real synthesized speech segments separated by silence.
 * @param plan - [{ text, voice } | { silence: seconds }]
 * @returns path of the cached WAV under .scratch, and the speech segment boundaries in seconds.
 */
export async function voiceFixture(plan) {
  const dir = resolve('.scratch/nexus-v1/voice-audio')
  await mkdir(dir, { recursive: true })
  const id = createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16)
  const path = resolve(dir, `capture-${id}.wav`)
  const parts = []
  const segments = []
  let seconds = 0
  for (const step of plan) {
    if ('silence' in step) { parts.push(silence(step.silence)); seconds += step.silence; continue }
    const piece = resolve(dir, `utterance-${createHash('sha256').update(step.voice + step.text).digest('hex').slice(0, 16)}.wav`)
    try { await access(piece) } catch { await synthesize(step.text, step.voice, piece) }
    const pcm = pcmOf(await readFile(piece))
    segments.push({ text: step.text, start: seconds, end: seconds + pcm.length / 2 / RATE })
    parts.push(pcm); seconds += pcm.length / 2 / RATE
  }
  await writeFile(path, wavOf(Buffer.concat(parts)))
  return { path, segments, seconds }
}
