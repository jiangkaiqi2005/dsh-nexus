import { spawn } from 'node:child_process'

/** Own a test Host from spawn through readiness, including failed startup. */
export async function startHost(command, args, options, ready) {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise(accept => child.once('close', accept))
  const failed = new Promise((_, reject) => child.once('error', reject))
  let closing
  const close = () => closing ??= (async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        // Kill this owned root and its descendants before the shell can orphan them.
        await new Promise((accept, reject) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.once('error', reject)
          killer.once('close', accept)
        })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    let timer
    try {
      await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`test Host ${child.pid} did not close`)), 10000) })])
    } finally { clearTimeout(timer) }
  })()
  let started = false
  try {
    const value = await Promise.race([ready(child), failed])
    started = true
    return { ...value, close }
  } finally {
    if (!started) await close()
  }
}
