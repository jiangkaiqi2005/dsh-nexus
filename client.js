window.__ModuleLoader__.load({
  id: 'dsh-nexus',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const SUPERVISOR = 'nexus-supervisor'

    // Client face of the Host call endpoint; typert.js holds the matching Host
    // descriptor with the same validation, so both ends accept exactly the same items.
    const isAudio = value => typeof value === 'string' && value.length <= 1 << 20 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
    const uplink = value => {
      if (value && typeof value === 'object' && Object.keys(value).length === 2 && ((value.type === 'audio' && isAudio(value.audio)) || (['played', 'hangup'].includes(value.type) && Number.isSafeInteger(value.samples) && value.samples >= 0))) return value
      throw new TypeError('nexusVoice/call uplink must be { type: "audio", audio: base64 } or { type: "played" | "hangup", samples }')
    }
    const frame = value => {
      if (value?.type === 'audio' && isAudio(value.audio)) return value
      if (value?.type === 'flush' && Object.keys(value).length === 1) return value
      if (value?.type === 'state' && ['connecting', 'live'].includes(value.state)) return value
      if (value?.type === 'state' && value.state === 'failed' && typeof value.code === 'string') return value
      throw new TypeError('nexusVoice/call frame is malformed')
    }
    const strict = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
    const CONTRIBUTION = {
      package: 'dsh-nexus',
      descriptors: [{
        id: 'dsh-nexus#nexusVoice/call', service: 'nexusVoice', namespace: 'nexusVoice', method: 'call', mode: 'stream',
        invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' },
        uplink: { codec: strict('dsh-nexus/voice#VoiceUplink', uplink) },
        result: strict('dsh-nexus/voice#VoiceFrame', frame),
      }],
    }

    const base64 = samples => {
      const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      return btoa(binary)
    }
    const pcm = audio => {
      const binary = atob(audio)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
    }
    const MIC_FAILURES = { NotAllowedError: 'mic-denied', SecurityError: 'mic-denied', NotFoundError: 'no-device', OverconstrainedError: 'no-device' }

    /**
     * One call of this client. It captures the microphone at 16 kHz, plays model
     * audio at 24 kHz, and reports only states it actually reached: "live" is
     * set when the Host says the model accepted the voice session. Each start is
     * its own attempt: hanging up releases what that attempt acquired, and an
     * ended attempt never touches the state or resources of a later one. When the
     * user starts speaking the Host sends a flush: everything still queued or
     * playing stops, and the client reports how much it actually played.
     */
    class Call {
      constructor() { this.state = 'idle'; this.code = undefined; this.played = 0; this.flushes = 0; this.discarded = 0; this.listeners = new Set(); this.attempt = undefined }
      subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
      set(state, code) { this.state = state; this.code = code; for (const listener of this.listeners) listener() }
      get active() { return ['requesting-mic', 'connecting', 'live'].includes(this.state) }
      async start(remote) {
        if (this.active) return
        const cleanups = []
        const attempt = { hangup: undefined, release: () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() } }
        this.attempt = attempt
        const current = () => this.attempt === attempt
        // Release this attempt; report a failure only while it is still the user's call.
        const end = (state, code) => {
          attempt.release()
          if (!current()) return
          this.attempt = undefined
          this.set(state, code)
        }
        this.played = 0
        this.flushes = 0
        this.discarded = 0
        this.set('requesting-mic')
        // Created within the user's click so playback is allowed to start.
        let playback
        try { playback = new AudioContext({ sampleRate: 24000 }) } catch { return end('playback-blocked') }
        cleanups.push(() => playback.close().catch(() => {}))
        await Promise.race([playback.resume().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))])
        if (!current()) return attempt.release()
        if (playback.state !== 'running') return end('playback-blocked', playback.state)
        if (!navigator.mediaDevices?.getUserMedia) return end('mic-failed', 'unsupported')
        let stream
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) }
        catch (error) { return end(MIC_FAILURES[error?.name] ?? 'mic-failed', error?.name) }
        cleanups.push(() => stream.getTracks().forEach(track => track.stop()))
        if (!current()) return attempt.release()
        if (!stream.getAudioTracks().length) return end('no-device')
        this.set('connecting')
        const handle = remote.call()
        // Keep the stream until the Host consumes the final playback report and ends it.
        const capture = new AudioContext({ sampleRate: 16000 })
        cleanups.push(() => capture.close().catch(() => {}))
        const source = capture.createMediaStreamSource(stream)
        const processor = capture.createScriptProcessor(2048, 1, 1)
        cleanups.push(() => { processor.disconnect(); source.disconnect() })
        processor.onaudioprocess = event => {
          if (!current() || this.state !== 'live') return
          const input = event.inputBuffer.getChannelData(0)
          const samples = new Int16Array(input.length)
          for (let i = 0; i < input.length; i++) samples[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff
          handle.send({ type: 'audio', audio: base64(samples) })
        }
        source.connect(processor)
        processor.connect(capture.destination)
        let next = 0
        // Scheduled playback since the last flush; finished nodes are counted as played and dropped.
        let nodes = []
        let finished = 0
        const retire = now => { while (nodes.length && nodes[0].start + nodes[0].samples / 24000 <= now) finished += nodes.shift().samples }
        const flush = () => {
          const now = playback.currentTime
          retire(now)
          let played = finished
          for (const { node, start, samples } of nodes) {
            const heard = Math.min(samples, Math.max(0, Math.round((now - start) * 24000)))
            played += heard
            this.discarded += samples - heard
            node.stop()
          }
          nodes = []
          finished = 0
          next = now
          return played
        }
        attempt.hangup = () => { const samples = flush(); if (this.state === 'live') handle.send({ type: 'hangup', samples }); else handle.dispose() }
        cleanups.push(() => flush())
        try {
          for await (const frame of handle) {
            if (!current()) continue // Let the Host consume the final report before disposing this stream.
            if (frame.type === 'state' && frame.state === 'live') this.set('live')
            else if (frame.type === 'state' && frame.state === 'failed') return end('failed', frame.code)
            else if (frame.type === 'flush') {
              const played = flush()
              this.flushes++
              handle.send({ type: 'played', samples: played })
              this.set(this.state, this.code)
            } else if (frame.type === 'audio') {
              const samples = pcm(frame.audio)
              const buffer = playback.createBuffer(1, samples.length, 24000)
              const channel = buffer.getChannelData(0)
              for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000
              const node = playback.createBufferSource()
              node.buffer = buffer
              node.connect(playback.destination)
              retire(playback.currentTime)
              next = Math.max(next, playback.currentTime)
              node.start(next)
              nodes.push({ node, start: next, samples: samples.length })
              next += buffer.duration
              this.played += samples.length
              this.set(this.state, this.code)
            }
          }
          end('failed', 'CALL_CLOSED')
        } catch (error) {
          end('failed', error?.code ?? 'CALL_CLOSED')
        } finally { handle.dispose() }
      }
      hangup() {
        const attempt = this.attempt
        attempt?.hangup?.()
        this.attempt = undefined
        this.set('idle')
        attempt?.release()
      }
    }

    // Flat keys: the locale service does not resolve nested ones.
    const states = table => Object.fromEntries(Object.entries(table).map(([state, text]) => [`state-${state}`, text]))
    const STATES = {
      en: { idle: 'Voice off', 'requesting-mic': 'Requesting microphone…', connecting: 'Connecting…', live: 'Live with Nexus', 'mic-denied': 'Microphone permission denied', 'no-device': 'No microphone available', 'mic-failed': 'Microphone failed', 'playback-blocked': 'Audio playback not ready', failed: 'Call failed' },
      zh: { idle: '语音未接通', 'requesting-mic': '正在请求麦克风…', connecting: '正在接通…', live: '已接通 Nexus', 'mic-denied': '麦克风权限被拒绝', 'no-device': '没有可用的麦克风', 'mic-failed': '麦克风不可用', 'playback-blocked': '音频播放未就绪', failed: '通话失败' },
    }

    function CallBar({ sessionId, call, remote, t }) {
      const [, render] = React.useReducer(count => count + 1, 0)
      React.useEffect(() => call.subscribe(render), [call])
      React.useEffect(() => { if (sessionId !== SUPERVISOR) call.hangup(); return () => call.hangup() }, [sessionId, call])
      if (sessionId !== SUPERVISOR) return null
      const busy = call.active
      return h('div', {
        'data-nexus-voice': '', 'data-state': call.state, 'data-played-samples': call.played, 'data-flushes': call.flushes, 'data-discarded-samples': call.discarded,
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 13 },
      },
      h('span', { role: 'status' }, t(`state-${call.state}`) + (call.code && !busy ? ` (${call.code})` : '')),
      h('button', {
        type: 'button', onClick: () => busy ? call.hangup() : call.start(remote),
        style: { color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 6, cursor: 'pointer', padding: '2px 10px' },
      }, busy ? t('hangup') : t('start')))
    }

    return {
      inject: ['slots', 'uiWorkspace', 'locale'],
      apply(ctx) {
        ctx.locale.register('nexus', 'en', { open: 'Open Nexus', start: 'Start voice', hangup: 'Hang up', ...states(STATES.en) })
        ctx.locale.register('nexus', 'zh', { open: '打开 Nexus', start: '接通语音', hangup: '挂断', ...states(STATES.zh) })
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'nexus', order: -10, locale: 'nexus',
          inject: () => ({ open: () => ctx.uiWorkspace.openSession(SUPERVISOR) }),
        }, ({ open, t, wide }) => h('button', {
          type: 'button', title: t('open'), 'aria-label': t('open'), onClick: open,
          style: { color: 'inherit', background: 'transparent', border: 0, cursor: 'pointer', padding: 8 },
        }, wide ? 'Nexus' : 'N')))
        const call = new Call()
        ctx.effect(() => () => call.hangup())
        ctx.inject(['remote'], async remoteCtx => {
          await remoteCtx.remote.$mount(CONTRIBUTION)
          remoteCtx.inject(['remote.nexusVoice', 'slots'], uiCtx => {
            uiCtx.slots.inject('conversation.input.dock', () => uiCtx.slots.register({
              name: 'conversation.input.dock', id: 'nexus-voice', locale: 'nexus',
              inject: sessionId => ({ sessionId, call, remote: uiCtx.remote.nexusVoice }),
            }, CallBar))
          })
        })
      },
    }
  },
})
