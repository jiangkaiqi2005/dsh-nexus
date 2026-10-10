import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Match Windows argv quoting; existing cmd.exe callers explicitly use verbatim args.
const quote = arg => '"' + arg.replace(/(\\*)"/g, (_, slashes) => slashes + slashes + '\\"').replace(/\\+$/, slashes => slashes + slashes) + '"'

/** Own a test Host from spawn through readiness, including failed startup. */
export async function startHost(command, args, options, ready) {
  const windows = process.platform === 'win32'
  const launch = windows ? {
    command: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./host-process.ps1', import.meta.url))],
    env: { ...(options.env ?? process.env), NEXUS_TEST_HOST_LAUNCH: Buffer.from(JSON.stringify({ command, arguments: options.windowsVerbatimArguments ? args.join(' ') : args.map(quote).join(' ') })).toString('base64') },
  } : { command, args, env: options.env }
  const child = spawn(launch.command, launch.args, { ...options, env: launch.env, windowsVerbatimArguments: false, detached: !windows, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise(accept => child.once('close', accept))
  const failed = new Promise((_, reject) => child.once('error', reject))
  let closing
  const close = () => closing ??= (async () => {
    if (child.pid) {
      if (windows) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
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
