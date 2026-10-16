window.__ModuleLoader__.load({
  id: 'dsh-nexus',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const SUPERVISOR = 'nexus-supervisor'

    // Client face of the Host call endpoint; typert.js holds the matching Host
    // descriptor with the same validation, so both ends accept exactly the same items.
    const isAudio = value => typeof value === 'string' && value.length <= 1 << 20 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
    const isPlayback = value => Array.isArray(value) && value.every(item => item && Object.keys(item).length === 2 && typeof item.replyId === 'string' && Number.isSafeInteger(item.samples) && item.samples >= 0)
    const uplink = value => {
      if (['ready', 'start-recording', 'end-recording'].includes(value?.type) && Object.keys(value).length === 1) return value
      if (value?.type === 'start-recording' && Object.keys(value).length === 2 && isPlayback(value.playback)) return value
      if (value?.type === 'played' && Object.keys(value).length === 3 && typeof value.replyId === 'string' && Number.isSafeInteger(value.samples) && value.samples >= 0) return value
      if (value?.type === 'hangup' && Object.keys(value).length === 3 && isPlayback(value.playback) && Number.isSafeInteger(value.samples) && value.samples >= 0) return value
      if (value && typeof value === 'object' && Object.keys(value).length === 2 && ((value.type === 'audio' && isAudio(value.audio)) || (['played', 'hangup'].includes(value.type) && Number.isSafeInteger(value.samples) && value.samples >= 0))) return value
      throw new TypeError('nexusVoice/call uplink must be ready/start-recording/end-recording, audio with base64, or played/hangup with samples')
    }
    const frame = value => {
      if (value?.type === 'audio' && isAudio(value.audio) && (value.replyId === undefined || typeof value.replyId === 'string')) return value
      if (value?.type === 'flush' && (value.replyId === undefined ? Object.keys(value).length === 1 : typeof value.replyId === 'string' && Object.keys(value).length === 2)) return value
      if (value?.type === 'activity' && ['thinking', 'reading', 'idle', 'failed', 'recording', 'recognizing', 'unheard'].includes(value.state) && (value.code === undefined || typeof value.code === 'string')) return value
      if (value?.type === 'state' && ['ready', 'connecting', 'live'].includes(value.state)) return value
      if (value?.type === 'state' && value.state === 'failed' && typeof value.code === 'string') return value
      throw new TypeError('nexusVoice/call frame is malformed')
    }
    const strict = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
    const CONTRIBUTION = {
      package: 'dsh-nexus',
      descriptors: [{
        id: 'dsh-nexus#nexusVoice/claimStartup', service: 'nexusVoice', namespace: 'nexusVoice', method: 'claimStartup',
        invocation: { kind: 'direct' }, parameters: [],
        cancellation: { parameter: 'signal' },
        result: strict('boolean', value => { if (typeof value === 'boolean') return value; throw new TypeError('startup claim must be boolean') }),
      }, {
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
      constructor() { this.state = 'idle'; this.activity = 'idle'; this.activityCode = undefined; this.recording = false; this.mode = 'realtime'; this.code = undefined; this.played = 0; this.flushes = 0; this.discarded = 0; this.listeners = new Set(); this.attempt = undefined; this.autoPending = false }
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
          this.recording = false
          this.set(state, code)
        }
        this.played = 0
        this.flushes = 0
        this.discarded = 0
        this.activity = 'idle'
        this.activityCode = undefined
        this.set('requesting-mic')
        const handle = remote.call()
        const frames = handle[Symbol.asyncIterator]()
        attempt.hangup = () => handle.dispose()
        let mediaReady = false
        cleanups.push(() => { if (!mediaReady) handle.dispose() })
        try {
          const first = await frames.next()
          if (!current()) return attempt.release()
          if (first.done || first.value.state !== 'ready') return end('failed', first.value?.code ?? 'CALL_CLOSED')
        } catch (error) { return end('failed', error?.code ?? 'CALL_CLOSED') }
        // A startup attempt also checks actual playback permission before claiming to be live.
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
        // Keep the stream until the Host consumes the final playback report and ends it.
        const capture = new AudioContext({ sampleRate: 16000 })
        cleanups.push(() => capture.close().catch(() => {}))
        const source = capture.createMediaStreamSource(stream)
        const captureAnalyser = capture.createAnalyser(), playbackAnalyser = playback.createAnalyser()
        captureAnalyser.fftSize = playbackAnalyser.fftSize = 256
        const samples = new Float32Array(256)
        attempt.level = kind => {
          const analyser = kind === 'rec' ? captureAnalyser : playbackAnalyser
          analyser.getFloatTimeDomainData(samples)
          return Math.min(1, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) * 4)
        }
        source.connect(captureAnalyser)
        cleanups.push(() => { captureAnalyser.disconnect(); playbackAnalyser.disconnect() })
        const processor = capture.createScriptProcessor(2048, 1, 1)
        cleanups.push(() => { processor.disconnect(); source.disconnect() })
        processor.onaudioprocess = event => {
          if (!current() || this.state !== 'live' || this.mode === 'cascade' && !this.recording) return
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
        const progress = new Map(), blocked = new Set()
        let deferred = [], deferring = false
        const playedReply = (replyId, samples) => {
          if (replyId === undefined) return
          progress.set(replyId, (progress.get(replyId) ?? 0) + samples)
          handle.send({ type: 'played', replyId, samples: progress.get(replyId) })
        }
        const playbackReport = () => [...progress].map(([replyId, samples]) => ({ replyId, samples }))
        let pendingActivity = 'idle'
        const retire = now => { while (nodes.length && nodes[0].start + nodes[0].samples / 24000 <= now) { const item = nodes.shift(); finished += item.samples; playedReply(item.replyId, item.samples) } }
        const flush = replyId => {
          deferred = replyId === undefined ? [] : deferred.filter(frame => frame.replyId !== replyId)
          const now = playback.currentTime
          retire(now)
          let played = finished
          const retained = []
          for (const item of nodes) {
            const { node, start, samples } = item
            if (replyId !== undefined && item.replyId !== replyId) { retained.push(item); continue }
            const heard = Math.min(samples, Math.max(0, Math.round((now - start) * 24000)))
            played += heard
            playedReply(item.replyId, heard)
            this.discarded += samples - heard
            node.stop()
          }
          nodes = retained
          finished = replyId === undefined ? 0 : played
          next = nodes.length ? nodes.at(-1).start + nodes.at(-1).samples / 24000 : now
          return played
        }
        const playAudio = frame => {
          if (frame.replyId !== undefined) {
            if (blocked.has(frame.replyId)) return
            if (!progress.has(frame.replyId)) progress.set(frame.replyId, 0)
          }
          const samples = pcm(frame.audio)
          const buffer = playback.createBuffer(1, samples.length, 24000)
          const channel = buffer.getChannelData(0)
          for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000
          const node = playback.createBufferSource()
          node.buffer = buffer
          node.connect(playback.destination)
          node.connect(playbackAnalyser)
          node.onended = () => { if (!current()) return; retire(playback.currentTime); if (!nodes.length && pendingActivity !== 'reading' && this.activity === 'reading') { this.activity = pendingActivity; this.set(this.state, this.code) } }
          retire(playback.currentTime)
          next = Math.max(next, playback.currentTime)
          node.start(next)
          nodes.push({ node, start: next, samples: samples.length, replyId: frame.replyId })
          next += buffer.duration
          this.played += samples.length
          this.set(this.state, this.code)
        }
        attempt.hangup = () => { const samples = flush(); if (this.state === 'live') handle.send({ type: 'hangup', samples, ...(this.mode === 'cascade' ? { playback: playbackReport() } : {}) }); else handle.dispose() }
        attempt.record = () => {
          if (!current() || this.state !== 'live' || this.mode !== 'cascade' || this.activity === 'recognizing') return
          this.recording = !this.recording
          if (this.recording) {
            deferring = true
            flush() // Stop locally, before a control frame can make a round trip to Host.
            for (const replyId of progress.keys()) blocked.add(replyId)
            handle.send({ type: 'start-recording', playback: playbackReport() })
            progress.clear()
          } else handle.send({ type: 'end-recording' })
          this.activity = this.recording ? 'recording' : 'recognizing'
          this.set(this.state, this.code)
        }
        cleanups.push(() => flush())
        try {
          mediaReady = true
          handle.send({ type: 'ready' })
          for (let nextFrame = await frames.next(); !nextFrame.done; nextFrame = await frames.next()) {
            const frame = nextFrame.value
            if (!current()) continue // Let the Host consume the final report before disposing this stream.
            if (frame.type === 'state' && ['connecting', 'live'].includes(frame.state)) { this.mode = frame.mode ?? 'realtime'; this.set(frame.state) }
            else if (frame.type === 'state' && frame.state === 'failed') return end('failed', frame.code)
            else if (frame.type === 'activity') {
              pendingActivity = frame.state
              if (frame.state === 'recording' && this.activity !== 'recognizing') this.recording = true
              else if (['recognizing', 'unheard'].includes(frame.state)) { this.recording = false; deferring = false }
              retire(playback.currentTime)
              this.activity = deferring ? this.recording ? 'recording' : 'recognizing' : nodes.length && !['failed', 'recording', 'recognizing', 'unheard'].includes(frame.state) ? 'reading' : frame.state
              this.activityCode = frame.code
              this.set(this.state, this.code)
              if (!this.recording && ['recognizing', 'unheard'].includes(frame.state)) for (const audio of deferred.splice(0)) playAudio(audio)
            }
            else if (frame.type === 'flush') {
              if (frame.replyId !== undefined) blocked.add(frame.replyId)
              const played = flush(frame.replyId)
              this.flushes++
              if (frame.replyId === undefined) handle.send({ type: 'played', samples: played })
              this.set(this.state, this.code)
            } else if (frame.type === 'audio') {
              if (deferring && this.mode === 'cascade') { if (!blocked.has(frame.replyId)) deferred.push(frame) }
              else playAudio(frame)
            }
          }
          end('failed', 'CALL_CLOSED')
        } catch (error) {
          end('failed', error?.code ?? 'CALL_CLOSED')
        } finally { handle.dispose() }
      }
      readLevel(kind) { return this.attempt?.level?.(kind) ?? 0 }
      hangup() {
        const attempt = this.attempt
        attempt?.hangup?.()
        this.attempt = undefined
        this.recording = false
        this.activity = 'idle'
        this.activityCode = undefined
        this.set('idle')
        attempt?.release()
      }
    }

    const VOICE_TEXT = {
      "语音未接通": "Voice off",
      "正在接通…": "Connecting…",
      "已接通 · 点按说话": "Connected · Tap to talk",
      "通话中 · 自动听写": "In call · Automatic transcription",
      "正在听": "Listening",
      "识别中…": "Recognizing…",
      "思考中…": "Thinking…",
      "正在朗读": "Reading aloud",
      "没听清，请再说一次": "Could not hear you, please try again",
      "朗读失败，文字已保留": "Read aloud failed; text is preserved",
      "麦克风权限被拒绝": "Microphone permission denied",
      "在浏览器地址栏或系统设置中允许麦克风后重试": "Allow the microphone in browser or system settings, then retry",
      "通话已中断": "Call interrupted",
      "与 Host 的连接断开": "Disconnected from Host",
      "未配置 DashScope 凭据": "DashScope credential is missing",
      "在 Host 配置 DASHSCOPE_API_KEY": "Configure DASHSCOPE_API_KEY on Host",
      "没有可用的麦克风": "No microphone available",
      "检查输入设备": "Check the input device",
      "麦克风无法使用": "Microphone unavailable",
      "浏览器暂不允许播放声音": "Browser audio playback is blocked",
      "点「重试」即可": "Click Retry",
      "另一个窗口正在通话": "Another window is in a call",
      "先在那个窗口挂断": "Hang up in that window first",
      "连不上语音服务": "Cannot connect to the voice service",
      "检查网络或端点设置": "Check the network or endpoint settings",
      "通话失败": "Call failed",
      "结束录音": "End recording",
      "点按插话": "Tap to interrupt",
      "点按说话": "Tap to talk",
      "挂断": "Hang up",
      "重试": "Retry",
      "接通语音": "Start voice",
      "级联": "Cascade",
      "回到 Nexus": "Back to Nexus",
    }

    const SETTINGS_TEXT = {
      "语音管家：听你说、替你调度工作会话、按需汇报": "Voice supervisor: listens, dispatches work sessions and reports when needed",
      "通话": "Calls",
      "语音模式": "Voice mode",
      "下一次接通时生效。级联更省钱，主管跟随 Harness 默认模型；Realtime 延迟更低。": "Applies on the next call. Cascade costs less and uses the Harness default model; Realtime has lower latency.",
      "启动后自动接通": "Connect automatically on startup",
      "下一次启动 Harness 时生效；挂断、刷新不会重新开麦。": "Applies on the next Harness startup; hanging up or refreshing will not reopen the microphone.",
      "语音服务": "Voice services",
      "合成音色": "Speech voice",
      "级联模式朗读所用的声音": "Voice used for read aloud in cascade mode",
      "高级：识别与合成端点、型号": "Advanced: recognition and synthesis endpoints and models",
      "识别端点": "Recognition endpoint",
      "识别型号": "Recognition model",
      "合成端点": "Synthesis endpoint",
      "合成型号": "Synthesis model",
      "上下文压缩": "Context compaction",
      "压缩预算": "Compaction budget",
      "主会话超过这个 token 数时，在轮次之间总结较早的历史": "Summarize older history between turns when the main conversation exceeds this token budget",
      "摘要模型": "Summary model",
      "默认 DeepSeek Flash，以最低思考强度运行": "DeepSeek Flash by default, using the lowest reasoning effort",
      "了解更多": "Learn more",
      "思考型模型摘要明显更慢，思考内容计入输出上限。预算应明显高于主管每次请求的固定开销（系统提示、工具定义等）；压缩几乎无效时会跳过。自动压缩期间会话显示通用的运行状态。": "Reasoning models summarize markedly slower, and reasoning counts toward the output limit. Keep the budget well above the fixed overhead of each supervisor request (system prompt, tool definitions, etc.); compaction is skipped when it would barely help. Automatic compaction shows the general running status.",
      "预算、摘要模型与思考强度立即生效。未另选时由 DeepSeek Flash 写摘要，并以该模型可用的最低思考强度运行。摘要无法让请求低于固定开销；自动压缩的运行状态与原生自动压缩一致。": "Budget, summary model and reasoning effort apply immediately. Summaries use DeepSeek Flash unless another model is selected, at the lowest effort the model offers. Summarizing cannot reduce a request below its fixed overhead; automatic compaction uses the same running status as native compaction.",
    }

    const VoiceUI = React.createContext(null)
    const useUI = () => React.useContext(VoiceUI)
    function useCall(call) {
      React.useSyncExternalStore(listener => call.subscribe(listener), () => call.ui.version)
      return call
    }
    // Presentation timestamps do not alter Call activities or the media lifecycle.
    function presentation(call) {
      const ui = { version: 0, nexusShown: 0, since: undefined, notice: undefined, expired: false }
      let recording = false, signature, timer
      const unsubscribe = call.subscribe(() => {
        if (call.recording && !recording) ui.since = Date.now()
        recording = call.recording
        if (call.state === 'idle' || call.state === 'requesting-mic') ui.failure = undefined
        else if (call.activityCode?.endsWith('CREDENTIAL_MISSING')) ui.failure = call.activityCode
        const next = [call.state, call.activity, call.activityCode].join(':')
        if (signature !== next) {
          signature = next
          clearTimeout(timer)
          ui.expired = false
          const code = call.activityCode ?? ''
          ui.notice = call.state === 'live' && (call.activity === 'unheard' || call.activity === 'failed' && /^(ASR_|TTS_)/.test(code) && !code.endsWith('CREDENTIAL_MISSING'))
          if (ui.notice) timer = setTimeout(() => { ui.expired = true; call.set(call.state, call.code) }, 4000)
        }
        ui.version++
      })
      ui.dispose = () => { clearTimeout(timer); unsubscribe() }
      return ui
    }
    function useLevels(active, count, tone) {
      const { call } = useUI()
      const [levels, setLevels] = React.useState(() => Array(count).fill(0.08))
      React.useEffect(() => {
        if (!active) { setLevels(Array(count).fill(0.08)); return }
        const id = setInterval(() => setLevels(levels => [...levels.slice(1), Math.max(0.08, call.readLevel(tone))]), 70)
        return () => clearInterval(id)
      }, [call, active, count, tone])
      return levels
    }
    function useElapsed(running) {
      const { call } = useUI()
      const [now, setNow] = React.useState(Date.now())
      React.useEffect(() => { if (!running) return; setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id) }, [running, call.ui.since])
      return Math.min(60, Math.max(0, Math.floor((now - (call.ui.since ?? now)) / 1000)))
    }
    const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    function describe(call) {
      const mode = call.mode
      let state = call.state === 'idle' ? 'off' : call.active && call.state !== 'live' ? 'connecting' : call.state === 'live' ? call.ui.expired && call.ui.notice ? 'ready' : call.activity === 'idle' ? 'ready' : call.activity : call.state
      const code = call.ui.failure ?? (call.state === 'live' ? call.activityCode : call.code)
      const failure = (text, hint = '') => ({ live: false, state, dot: 'error', text, tone: 'error', code: code ?? state, hint })
      if (!['off', 'connecting'].includes(state)) {
        if (code?.endsWith('CREDENTIAL_MISSING')) return failure('未配置 DashScope 凭据', '在 Host 配置 DASHSCOPE_API_KEY')
        if (state === 'mic-denied') return failure('麦克风权限被拒绝', '在浏览器地址栏或系统设置中允许麦克风后重试')
        if (state === 'no-device') return failure('没有可用的麦克风', '检查输入设备')
        if (state === 'mic-failed') return failure('麦克风无法使用', '检查输入设备')
        if (state === 'playback-blocked') return failure('浏览器暂不允许播放声音', '点「重试」即可')
        if (state === 'failed') {
          if (code === 'CALL_BUSY') return failure('另一个窗口正在通话', '先在那个窗口挂断')
          if (['CALL_CLOSED', 'CONNECTION_CLOSED'].includes(code)) return failure('通话已中断', '与 Host 的连接断开')
          if (['CONNECTION_FAILED', 'TIMEOUT'].includes(code)) return failure('连不上语音服务', '检查网络或端点设置')
          if (code?.startsWith('ASR_') && call.state === 'live') state = 'unheard'
          else if (code?.startsWith('TTS_') && call.state === 'live') state = 'tts-failed'
          else return failure('通话失败')
        }
      }
      if (mode === 'realtime' && ['recording', 'recording-late', 'recognizing'].includes(state)) state = 'ready'
      const base = { live: !['off', 'connecting', 'mic-denied', 'call-failed'].includes(state), state }
      switch (state) {
        case 'off': return { ...base, dot: 'idle', text: '语音未接通', tone: 'muted' }
        case 'connecting': return { ...base, dot: 'ongoing', text: '正在接通…', shimmer: true }
        case 'ready': return { ...base, dot: 'done', text: mode === 'cascade' ? '已接通 · 点按说话' : '通话中 · 自动听写' }
        case 'recording': case 'recording-late': return { ...base, dot: 'error', text: '正在听', recording: true }
        case 'recognizing': return { ...base, dot: 'ongoing', text: '识别中…', shimmer: true }
        case 'thinking': return { ...base, dot: 'ongoing', text: '思考中…', shimmer: true }
        case 'reading': return { ...base, dot: 'done', text: '正在朗读', speaking: true }
        case 'unheard': return { ...base, dot: 'warning', text: '没听清，请再说一次', tone: 'warn', code }
        case 'tts-failed': return { ...base, dot: 'warning', text: '朗读失败，文字已保留', tone: 'warn', code }
      }
    }
    const canRecord = d => d.live && !['recognizing'].includes(d.state)
    const recordLabel = d => d.recording ? '结束录音' : d.state === 'reading' ? '点按插话' : '点按说话'
    const connect = (call, remote) => { call.autoPending = false; call.ui.retry = undefined; call.ui.running = call.start(remote) }
    const hangup = call => { call.autoPending = false; call.ui.retry = undefined; call.hangup() }
    const retry = async (call, remote) => {
      const previous = call.ui.running, pending = {}
      call.ui.retry = pending
      call.hangup()
      // The Host releases its media owner when the previous stream finishes.
      await previous
      if (call.ui.retry === pending) connect(call, remote)
    }

    // ---------- shared bits ----------
    const NexusMark = ({ size = 18 }) => h('svg', { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true, className: 'nx-mark' },
      h('rect', { width: 64, height: 64, rx: 16, fill: '#176b69' }),
      h('path', { d: 'M18 46V18l28 28V18', fill: 'none', stroke: '#fff', strokeWidth: 6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('circle', { cx: 46, cy: 18, r: 5, fill: '#aaf0d1' }))
    const HangupIcon = ({ size = 16 }) => h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true },
      h('path', { d: 'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.270 11.270 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z', fill: 'currentColor' }))
    function Bars({ active, count = 24, tone = 'accent', className = '' }) {
      const levels = useLevels(active, count, tone)
      return h('span', { className: `nx-bars nx-bars-${tone} ${className}`, 'aria-hidden': true }, levels.map((level, i) => h('i', { key: i, style: { transform: `scaleY(${level})` } })))
    }
    function Status({ d, compact }) {
      const { t } = useUI()
      const elapsed = useElapsed(!!d.recording)
      const text = d.shimmer ? h(P.TextShimmer, { active: true }, t(d.text)) : t(d.text)
      return h('span', { className: `nx-status nx-tone-${d.tone ?? 'normal'}`, role: 'status' },
        h(P.StateDot, { state: d.dot, size: d.dot === 'ongoing' ? 12 : 8 }),
        h('span', { className: 'nx-status-text' }, text),
        d.recording ? h('span', { className: `nx-timer ${elapsed >= 50 ? 'nx-timer-late' : ''}` }, compact ? clock(elapsed) : `${clock(elapsed)} / 1:00`) : null,
        d.code ? h(P.Tooltip, { label: d.hint ? `${t(d.hint)} · ${d.code}` : d.code, side: 'top' }, h('span', { className: 'nx-info', tabIndex: 0 }, h(P.IconInfoOutlineRegular, { size: 14 }))) : null)
    }
    function RecordButton({ d, round, size }) {
      const { call, t } = useUI()
      const props = { type: 'button', disabled: !canRecord(d), onClick: () => call.attempt?.record?.(), 'aria-label': t(recordLabel(d)), 'aria-pressed': !!d.recording }
      if (round) return h('button', { ...props, className: `nx-round nx-round-${size ?? 'lg'} ${d.recording ? 'nx-round-rec' : 'nx-round-accent'}` },
        d.recording ? h(P.IconStopFillRegular, { size: size === 'sm' ? 12 : 18 }) : h(P.IconMicrophoneOutlineMedium, { size: size === 'sm' ? 16 : 24 }))
      return h(P.Button, { ...props, size: 'sm', variant: d.recording ? 'outline' : 'primary', className: d.recording ? 'nx-btn-rec' : 'nx-btn-accent', icon: d.recording ? h(P.IconStopFillRegular, { size: 12 }) : h(P.IconMicrophoneOutlineMedium, { size: 16 }) }, t(recordLabel(d)))
    }
    const HangupButton = ({ size = 'md' }) => { const { call, t } = useUI(); return h(P.Tooltip, { label: t('挂断'), side: 'top' },
      h('button', { type: 'button', className: `nx-round nx-round-${size} nx-round-hangup`, onClick: () => hangup(call), 'aria-label': t('挂断') }, h(HangupIcon, { size: size === 'sm' ? 17 : 20 }))) }
    const RetryButton = () => { const { call, remote, t } = useUI(); return h(P.Button, { type: 'button', size: 'sm', variant: 'outline', icon: h(P.IconRefreshOutlineRegular, { size: 14 }), onClick: () => retry(call, remote) }, t('重试')) }
    const ConnectButton = ({ variant = 'primary' }) => { const { call, remote, t } = useUI(); return h(P.Button, { type: 'button', size: 'sm', variant, className: 'nx-btn-accent', onClick: () => connect(call, remote) }, t('接通语音')) }
    const ModeTag = ({ mode }) => { const { t } = useUI(); return h('span', { className: 'nx-tag' }, mode === 'cascade' ? t('级联') : 'Realtime') }
    const voiceAttributes = call => ({
      'data-nexus-voice': '', 'data-state': call.state, 'data-activity': call.activity, 'data-played-samples': call.played, 'data-flushes': call.flushes, 'data-discarded-samples': call.discarded,
    })
    function BarA({ d, mode }) {
      return h('div', { className: 'nx-a-bar', ...voiceAttributes(useUI().call) },
        h(NexusMark, { size: 18 }),
        h(Status, { d }),
        d.recording ? h(Bars, { active: true, tone: 'rec', count: 28, className: 'nx-a-wave' }) : d.speaking ? h(Bars, { active: true, count: 12, className: 'nx-a-wave nx-a-wave-short' }) : null,
        h('span', { className: 'nx-spacer' }),
        d.live ? h(ModeTag, { mode }) : null,
        d.state === 'off' ? h(ConnectButton, null) : d.tone === 'error' ? h(RetryButton) : null,
        d.live && mode === 'cascade' ? h(RecordButton, { d }) : null,
        d.state !== 'off' ? h(HangupButton, { size: 'sm' }) : null)
    }
    // Where this viewer dropped the pill, in the browser's own storage; any storage failure means the top center.
    const PILL_KEY = 'dsh-nexus.pillPosition'
    const readPill = () => { try { const value = JSON.parse(localStorage.getItem(PILL_KEY)); return Number.isFinite(value?.x) && Number.isFinite(value?.y) ? { x: value.x, y: value.y } : undefined } catch { return undefined } }
    const writePill = value => { try { localStorage.setItem(PILL_KEY, JSON.stringify(value)) } catch {} }
    // Dragging past a few pixels moves the pill and swallows the click that ends it. The spot
    // stays inside the overlay layer; a smaller window pulls the pill in without losing the spot.
    function usePillDrag() {
      const ref = React.useRef(null), saved = React.useRef(), moved = React.useRef(false)
      const [position, setPosition] = React.useState()
      const fit = React.useCallback(target => {
        // A drag can outlive the pill, for example when the call ends mid-drag; the mounted pill always has its layer.
        const pill = ref.current
        if (!target || !pill) return undefined
        const layer = pill.offsetParent, clamp = (value, max) => Math.max(0, Math.min(value, max))
        return { x: clamp(target.x, layer.clientWidth - pill.offsetWidth), y: clamp(target.y, layer.clientHeight - pill.offsetHeight) }
      }, [])
      React.useLayoutEffect(() => {
        saved.current = readPill()
        const place = () => setPosition(fit(saved.current))
        place()
        const observer = new ResizeObserver(place)
        observer.observe(ref.current)
        observer.observe(ref.current.offsetParent)
        return () => observer.disconnect()
      }, [fit])
      const onPointerDown = event => {
        moved.current = false
        // The blank area and the icon/status area drag; the round buttons only click.
        if (event.button !== 0 || event.target.closest('button:not(.nx-a-pill-main)')) return
        const pill = ref.current, layer = pill.offsetParent, from = pill.getBoundingClientRect(), origin = layer.getBoundingClientRect()
        const start = { x: from.left - origin.left - layer.clientLeft, y: from.top - origin.top - layer.clientTop }
        const move = e => {
          if (e.pointerId !== event.pointerId) return
          const dx = e.clientX - event.clientX, dy = e.clientY - event.clientY
          if (!moved.current && Math.hypot(dx, dy) < 4) return
          moved.current = true
          saved.current = { x: start.x + dx, y: start.y + dy }
          setPosition(fit(saved.current))
        }
        const up = e => {
          if (e.pointerId !== event.pointerId) return
          removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
          const spot = fit(saved.current)
          if (moved.current && spot) { saved.current = spot; writePill(spot) }
          // The click this release may produce comes first; a later click is not part of the drag.
          setTimeout(() => { moved.current = false })
        }
        addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up)
      }
      const onClickCapture = event => { if (moved.current) { event.preventDefault(); event.stopPropagation() } }
      return { ref, position, onPointerDown, onClickCapture }
    }
    function PillA({ d, mode }) {
      const drag = usePillDrag()
      return h('div', { className: drag.position ? 'nx-a-pill nx-a-pill-placed' : 'nx-a-pill', ...voiceAttributes(useUI().call), ref: drag.ref, style: drag.position && { left: drag.position.x, top: drag.position.y }, onPointerDown: drag.onPointerDown, onClickCapture: drag.onClickCapture },
        h('button', { type: 'button', className: 'nx-a-pill-main', onClick: useUI().open, title: useUI().t('回到 Nexus') }, h(NexusMark, { size: 16 }), h(Status, { d, compact: true })),
        d.recording ? h(Bars, { active: true, tone: 'rec', count: 10 }) : d.speaking ? h(Bars, { active: true, count: 8 }) : null,
        d.tone === 'error' ? h(RetryButton) : null,
        d.live && mode === 'cascade' ? h(RecordButton, { d, round: true, size: 'sm' }) : null,
        h(HangupButton, { size: 'sm' }))
    }

    function CallBar({ sessionId, call, remote, t, open, floating = false }) {
      useCall(call)
      const shown = sessionId === SUPERVISOR
      React.useLayoutEffect(() => {
        if (!shown) return
        call.ui.nexusShown++
        call.set(call.state, call.code)
        return () => { call.ui.nexusShown--; call.set(call.state, call.code) }
      }, [shown, call])
      React.useEffect(() => {
        if (shown && call.autoPending) connect(call, remote)
      }, [shown, call, remote, call.autoPending])
      if (floating ? call.state === 'idle' || call.ui.nexusShown > 0 && !call.ui.modalTarget : !shown || !call.ui.nexusShown || call.ui.modalTarget) return null
      const d = describe(call)
      const control = h(VoiceUI.Provider, { value: { call, remote, t, open } }, h(floating ? PillA : BarA, { d, mode: call.mode }))
      return floating && call.ui.modalTarget ? createPortal(control, call.ui.modalTarget) : control
    }
    // Settings covers the still-mounted conversation. Keep the same pill above its
    // mask, in the viewport-sized modal layer, without changing the settings page.
    function SettingsCallSurface({ call }) {
      const anchor = React.useRef(null)
      React.useLayoutEffect(() => {
        call.ui.modalTarget = anchor.current.closest('[role="dialog"]').parentElement
        call.set(call.state, call.code)
        return () => { call.ui.modalTarget = undefined; call.set(call.state, call.code) }
      }, [call])
      return h('span', { hidden: true, ref: anchor })
    }
    function SidebarEntry({ open, wide, call, t }) {
      useCall(call)
      const d = describe(call)
      const dot = d.recording ? 'rec' : d.tone === 'error' ? 'error' : d.live ? 'live' : null
      return h(P.Tooltip, { label: wide ? t('open') : `${t('open')}${d.live ? ' · ' + t(d.text) : ''}`, side: 'right' },
        h('button', { type: 'button', className: `nx-side ${wide ? 'nx-side-wide' : ''}`, 'aria-label': t('open'), onClick: open },
          h('span', { className: 'nx-side-icon' }, h(NexusMark, { size: 20 }), dot ? h('i', { className: `nx-side-dot nx-side-dot-${dot}` }) : null),
          wide ? h('span', null, 'Nexus') : null))
    }

    const CSS = `
:root, body { --nx-accent: color-mix(in srgb, #176b69 62%, var(--dsw-alias-label-primary, #000)); --nx-accent-soft: color-mix(in srgb, #176b69 18%, transparent); --nx-accent-fill: #176b69; --nx-rec: var(--dsw-alias-state-error-primary, #f25a5a); }
.nx-mark { flex: none; border-radius: 25%; }
.nx-spacer { flex: 1 1 auto; }
.nx-status { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-primary); white-space: nowrap; }
.nx-status-text { overflow: hidden; text-overflow: ellipsis; }
.nx-tone-muted { color: var(--dsw-alias-label-tertiary); }
.nx-tone-warn { color: var(--dsw-alias-state-warn-secondary); }
.nx-tone-error { color: var(--dsw-alias-state-error-primary); }
.nx-timer { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.nx-timer-late { color: var(--dsw-alias-state-warn-secondary); font-weight: 600; }
.nx-info { display: inline-flex; color: var(--dsw-alias-label-tertiary); cursor: help; }
.nx-tag { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 0 8px; line-height: 20px; }
.nx-bars { display: inline-flex; align-items: center; gap: 2px; height: 20px; flex: none; }
.nx-bars i { display: block; width: 3px; height: 100%; border-radius: 2px; background: var(--nx-accent); transform-origin: center; transition: transform 70ms linear; }
.nx-bars-rec i { background: var(--nx-rec); }
.nx-btn-accent:not(:disabled) { background: var(--nx-accent-fill) !important; color: #fff !important; border-color: transparent !important; }
.nx-btn-rec { color: var(--nx-rec) !important; border-color: color-mix(in srgb, var(--nx-rec) 50%, transparent) !important; }
.nx-round { display: inline-flex; align-items: center; justify-content: center; flex: none; border: 0; border-radius: 999px; cursor: pointer; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); transition: background 120ms, transform 120ms; }
.nx-round:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-layer-3)); }
.nx-round:active:not(:disabled) { transform: scale(0.94); }
.nx-round:disabled { opacity: 0.4; cursor: default; }
.nx-round-sm { width: 28px; height: 28px; } .nx-round-md { width: 36px; height: 36px; } .nx-round-lg { width: 52px; height: 52px; }
.nx-round-accent { background: var(--nx-accent-fill); color: #fff; } .nx-round-accent:hover:not(:disabled) { background: color-mix(in srgb, var(--nx-accent-fill) 85%, #fff); }
.nx-round-rec { background: var(--nx-rec); color: #fff; box-shadow: 0 0 0 4px color-mix(in srgb, var(--nx-rec) 22%, transparent); animation: nx-pulse 1.4s ease-in-out infinite; } .nx-round-rec:hover:not(:disabled) { background: color-mix(in srgb, var(--nx-rec) 85%, #000); }
.nx-round-hangup { background: transparent; color: var(--dsw-alias-label-tertiary); } .nx-round-hangup:hover { background: color-mix(in srgb, var(--nx-rec) 16%, transparent) !important; color: var(--nx-rec); }
@keyframes nx-pulse { 50% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--nx-rec) 10%, transparent); } }

/* A */
.nx-a-bar { display: flex; align-items: center; gap: 10px; margin: 0 16px 8px; padding: 6px 6px 6px 12px; min-height: 44px; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); }
/* As wide as the host input card, in the empty hero and in the full-width conversation dock. */
.nx-a-bar { width: calc(100% - var(--dsh-composer-side-clearance) * 2); max-width: var(--dsh-composer-card-max-width); margin-inline: auto; }
.nx-a-wave { margin-left: 4px; } .nx-a-wave-short i { width: 2px; }
.nx-a-pill { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-shadow-lv3); z-index: 20; }
.nx-a-pill-main { display: inline-flex; align-items: center; gap: 8px; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 2px 6px 2px 2px; border-radius: 999px; } .nx-a-pill-main:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* The Windows title bar is a window drag region: opt out so the controls click, and let the pill drag itself. */
.nx-a-bar, .nx-a-bar *, .nx-a-pill, .nx-a-pill * { -webkit-app-region: no-drag; }
.nx-a-pill { user-select: none; touch-action: none; }
.nx-a-pill.nx-a-pill-placed { transform: none; }

/* sidebar */
.nx-side { display: inline-flex; align-items: center; gap: 8px; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 6px; border-radius: var(--dsw-radius-md); font: var(--dsw-font-s-14); } .nx-side:hover { background: var(--dsw-alias-interactive-bg-hover); }
.nx-side-wide { padding: 6px 10px 6px 6px; }
.nx-side-icon { position: relative; display: inline-flex; }
.nx-side-dot { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: 999px; border: 2px solid var(--dsw-alias-bg-base); }
.nx-side-dot-live { background: var(--dsw-alias-state-success-primary); } .nx-side-dot-rec { background: var(--nx-rec); animation: nx-blink 1s steps(2) infinite; } .nx-side-dot-error { background: var(--dsw-alias-state-warn-primary); }
@keyframes nx-blink { 50% { opacity: 0.35; } }

/* settings — mirrors native settings rows */
.nx-set { padding: 4px 0 24px; color: var(--dsw-alias-label-primary); }
.nx-set-head { display: flex; align-items: center; gap: 12px; padding-bottom: 8px; }
.nx-set-h1 { font: var(--dsw-font-m-18); }
.nx-set-group { font: var(--dsw-font-s-strong-14); margin: 24px 0 4px; color: var(--dsw-alias-label-primary); }
.nx-set-row { display: flex; align-items: center; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.nx-set-row-stack { flex-direction: column; align-items: stretch; gap: 8px; }
.nx-set-label { flex: 1 1 auto; min-width: 0; } .nx-set-title { font: var(--dsw-font-s-14); } .nx-set-desc { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
.nx-set-control { flex: none; display: flex; } .nx-set-row-stack .nx-set-control { flex: 1 1 auto; }
.nx-set-input, .nx-set-select { height: 36px; box-sizing: border-box; padding: 0 12px; border-radius: var(--dsw-radius-md); border: 1px solid transparent; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-13); min-width: 220px; outline: none; }
.nx-set-input:focus, .nx-set-select:focus { border-color: var(--nx-accent); }
.nx-set-row-stack .nx-set-input { width: 100%; }
.nx-set-input-num { min-width: 0; width: 140px; text-align: right; font-variant-numeric: tabular-nums; }
.nx-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.nx-set-disclosure { border-bottom: 1px solid var(--dsw-alias-border-l2); }
.nx-set-toggle { display: flex; align-items: center; gap: 6px; width: 100%; padding: 14px 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xs-13); cursor: pointer; text-align: left; }
.nx-set-toggle:hover { color: var(--dsw-alias-label-primary); }
.nx-chev { display: inline-flex; transition: transform 150ms; } .nx-chev-open { transform: rotate(180deg); }
.nx-set-disclosure-body { padding: 0 0 8px 12px; border-left: 2px solid var(--dsw-alias-border-l2); margin-bottom: 12px; }
.nx-set-disclosure-body .nx-set-row:last-child { border-bottom: 0; }
.nx-set-note { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); margin: 0; line-height: 20px; }

`

    // As DEFAULT_SUMMARY_MODEL in src/compaction.ts: the summary model while the setting is empty.
    const DEFAULT_SUMMARY_MODEL = 'deepseek-account/deepseek-flash'
    // As lowestEffort in src/compaction.ts: an effort that turns thinking off, then minimal, then low.
    const lowestEffort = efforts => {
      const named = pattern => efforts.find(effort => pattern.test(effort.id) || pattern.test(effort.name))
      return named(/^(?:none|off|disabled?)$/i) ?? named(/^minimal$/i) ?? named(/^low$/i)
    }

    const Row = ({ title, desc, children, stack }) => h('div', { className: `nx-set-row ${stack ? 'nx-set-row-stack' : ''}` },
      h('div', { className: 'nx-set-label' }, h('div', { className: 'nx-set-title' }, title), desc ? h('div', { className: 'nx-set-desc' }, desc) : null),
      h('div', { className: 'nx-set-control' }, children))
    function Disclosure({ label, children, open: initial = false }) {
      const [open, setOpen] = React.useState(initial)
      return h('div', { className: 'nx-set-disclosure' },
        h('button', { type: 'button', className: 'nx-set-toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
          label, h('span', { className: `nx-chev ${open ? 'nx-chev-open' : ''}` }, h(P.IconChevronDownOutlineRegular, { size: 14 }))),
        open ? h('div', { className: 'nx-set-disclosure-body' }, children) : null)
    }
    function Settings({ form, catalog, t }) {
      const snapshot = React.useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
      const [error, setError] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [budget, setBudget] = React.useState()
      const [models, setModels] = React.useState()
      const [draft, setDraft] = React.useState({})
      React.useEffect(() => {
        let live = true
        catalog().then(response => { if (live && response.ok) setModels(response.value) }, () => {})
        return () => { live = false }
      }, [catalog])
      const disabled = snapshot.status !== 'ready' || !snapshot.writable || saving
      const save = async (key, value) => {
        setSaving(true)
        try { setError(!(await form.set(key, value))) } catch { setError(true) }
        finally { setSaving(false) }
      }
      const savedBudget = snapshot.value?.compactionBudget ?? 128000
      const commitBudget = () => {
        const value = Number(budget)
        setBudget(undefined)
        if (budget !== undefined && Number.isSafeInteger(value) && value >= 1 && value !== savedBudget) save('compactionBudget', value)
      }
      const summaryModel = snapshot.value?.summaryModel ?? ''
      const routes = (models?.groups ?? []).flatMap(group => group.models.map(model => ({ value: `${group.id}/${model.id}`, label: `${group.name} / ${model.name || model.id}` })))
      if (summaryModel && !routes.some(route => route.value === summaryModel)) routes.unshift({ value: summaryModel, label: summaryModel })
      // Efforts the summary model offers; empty takes the lowest of them, model-default (MODEL_DEFAULT_EFFORT in src/compaction.ts) sends none.
      const route = summaryModel || DEFAULT_SUMMARY_MODEL
      const slash = route.indexOf('/')
      const [provider, modelId] = [route.slice(0, slash), route.slice(slash + 1)]
      const efforts = models?.groups.find(group => group.id === provider)?.models.find(model => model.id === modelId)?.reasoning?.efforts ?? []
      const lowest = lowestEffort(efforts)
      const savedEffort = snapshot.value?.summaryReasoningEffort ?? ''
      const effort = savedEffort === 'model-default' || efforts.some(item => item.id === savedEffort) ? savedEffort : ''
      const effortOptions = !efforts.length ? [h('option', { key: '', value: '' }, t('effort-none'))] : [
        h('option', { key: '', value: '' }, lowest ? `${t('effort-lowest')} (${lowest.name})` : t('effort-model-default')),
        ...lowest ? [h('option', { key: 'model-default', value: 'model-default' }, t('effort-model-default'))] : [],
        ...efforts.map(item => h('option', { key: item.id, value: item.id }, item.name)),
      ]
      const v = snapshot.value ?? {}
      const commitText = key => {
        if (draft[key] !== undefined) {
          const value = draft[key].trim()
          setDraft(current => { const next = { ...current }; delete next[key]; return next })
          if (value && value !== v[key]) save(key, value)
        }
      }
      const text = (key, label, fallback, mono = true) => h('input', {
        className: `nx-set-input ${mono ? 'nx-mono' : ''}`, type: 'text', 'aria-label': t(label), disabled, value: draft[key] ?? v[key] ?? fallback,
        onChange: event => setDraft({ ...draft, [key]: event.target.value }),
        onBlur: () => commitText(key),
        onKeyDown: event => { if (event.key === 'Enter') commitText(key) },
      })
      return h('div', { className: 'nx-set' },
        h('div', { className: 'nx-set-head' }, h(NexusMark, { size: 28 }), h('div', null, h('div', { className: 'nx-set-h1' }, 'Nexus'), h('div', { className: 'nx-set-desc' }, t('语音管家：听你说、替你调度工作会话、按需汇报')))),
        h('div', { className: 'nx-set-group' }, t('通话')),
        h(Row, { title: t('语音模式'), desc: t('下一次接通时生效。级联更省钱，主管跟随 Harness 默认模型；Realtime 延迟更低。') },
          h(P.SegmentedControl, { id: 'nexus-voice-mode', label: t('语音模式'), value: v.voiceMode ?? 'cascade', disabled, onChange: value => save('voiceMode', value), options: [{ value: 'cascade', label: t('级联') }, { value: 'realtime', label: 'Realtime' }] })),
        h(Row, { title: t('启动后自动接通'), desc: t('下一次启动 Harness 时生效；挂断、刷新不会重新开麦。') },
          h(P.Switch, { label: t('启动后自动接通'), checked: v.autoVoice ?? false, disabled, onChange: value => save('autoVoice', value) })),
        h('div', { className: 'nx-set-group' }, t('语音服务')),
        h(Row, { title: t('合成音色'), desc: t('级联模式朗读所用的声音') }, text('ttsVoice', '合成音色', 'longanhuan_v3.1')),
        h(Disclosure, { label: t('高级：识别与合成端点、型号') },
          h(Row, { title: t('识别端点'), stack: true }, text('asrEndpoint', '识别端点', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')),
          h(Row, { title: t('识别型号') }, text('asrModel', '识别型号', 'qwen-audio-3.1-asr-flash')),
          h(Row, { title: t('合成端点'), stack: true }, text('ttsEndpoint', '合成端点', 'wss://dashscope.aliyuncs.com/api-ws/v1/inference')),
          h(Row, { title: t('合成型号') }, text('ttsModel', '合成型号', 'qwen-audio-3.1-tts-flash'))),
        h('div', { className: 'nx-set-group' }, t('上下文压缩')),
        h(Row, { title: t('压缩预算'), desc: t('主会话超过这个 token 数时，在轮次之间总结较早的历史') },
          h('input', { className: 'nx-set-input nx-set-input-num', type: 'number', 'aria-label': t('压缩预算'), min: 1, step: 1, disabled, value: budget ?? savedBudget, onChange: event => setBudget(event.target.value), onBlur: commitBudget, onKeyDown: event => { if (event.key === 'Enter') commitBudget() } })),
        h(Row, { title: t('摘要模型'), desc: t('默认 DeepSeek Flash，以最低思考强度运行') },
          h('select', { className: 'nx-set-select', 'aria-label': t('摘要模型'), disabled, value: v.summaryModel ?? '', onChange: e => save('summaryModel', e.target.value) },
            h('option', { value: '' }, `${t('summary-default')}（${DEFAULT_SUMMARY_MODEL}）`), ...routes.map(r => h('option', { key: r.value, value: r.value }, r.label)))),
        h(Row, { title: t('summary-effort') },
          h('select', { className: 'nx-set-select', 'aria-label': t('summary-effort'), value: effort, disabled: disabled || !efforts.length,
            onChange: event => save('summaryReasoningEffort', event.target.value),
          }, ...effortOptions)),
        h(Disclosure, { label: t('了解更多') },
          h('p', { className: 'nx-set-note' }, t('思考型模型摘要明显更慢，思考内容计入输出上限。预算应明显高于主管每次请求的固定开销（系统提示、工具定义等）；压缩几乎无效时会跳过。自动压缩期间会话显示通用的运行状态。')),
          h('p', { className: 'nx-set-note' }, t('预算、摘要模型与思考强度立即生效。未另选时由 DeepSeek Flash 写摘要，并以该模型可用的最低思考强度运行。摘要无法让请求低于固定开销；自动压缩的运行状态与原生自动压缩一致。'))),
        error ? h('p', { role: 'alert' }, t('save-failed')) : null)
    }

    return {
      inject: ['slots', 'uiWorkspace', 'locale'],
      apply(ctx) {
        const style = document.createElement('style'); style.textContent = CSS; document.head.append(style)
        ctx.effect(() => () => style.remove())
        const call = new Call()
        call.ui = presentation(call)
        ctx.effect(() => () => call.ui.dispose())
        ctx.locale.register('nexus', 'en', { open: 'Open Nexus', 'save-failed': 'Could not save the setting.', 'summary-default': 'Default', 'summary-effort': 'Summary reasoning effort', 'effort-lowest': 'Lowest', 'effort-model-default': 'Model default', 'effort-none': 'This model offers no reasoning efforts', ...VOICE_TEXT, ...SETTINGS_TEXT })
        ctx.locale.register('nexus', 'zh', { open: '打开 Nexus', 'save-failed': '设置保存失败。', 'summary-default': '默认', 'summary-effort': '摘要思考强度', 'effort-lowest': '最低', 'effort-model-default': '模型默认', 'effort-none': '该模型不提供思考强度选项', ...Object.fromEntries(Object.keys({ ...VOICE_TEXT, ...SETTINGS_TEXT }).map(text => [text, text])) })
        ctx.inject(['configForms', 'remote', 'remote.session'], settingsCtx => {
          const form = settingsCtx.configForms.get('nexus')
          const catalog = () => settingsCtx.remote.session.modelCatalog()
          settingsCtx.slots.inject('settings.section', () => settingsCtx.slots.register({
            name: 'settings.section', id: 'nexus', label: 'Nexus', locale: 'nexus',
            inject: () => ({ form, catalog }),
          }, Settings))
        })
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'nexus', order: -10, locale: 'nexus',
          inject: () => ({ call, open: () => ctx.uiWorkspace.openSession(SUPERVISOR) }),
        }, SidebarEntry))
        ctx.slots.inject('settings.action', () => ctx.slots.register({
          name: 'settings.action', id: 'nexus-call-surface', inject: () => ({ call }),
        }, SettingsCallSurface))
        ctx.effect(() => () => hangup(call))
        ctx.inject(['remote'], async remoteCtx => {
          await remoteCtx.remote.$mount(CONTRIBUTION)
          remoteCtx.inject(['remote.nexusVoice', 'slots'], uiCtx => {
            let disposed = false
            uiCtx.effect(() => () => { disposed = true })
            uiCtx.slots.inject('conversation.input.dock', () => uiCtx.slots.register({
              name: 'conversation.input.dock', id: 'nexus-voice', locale: 'nexus',
              inject: sessionId => ({ sessionId, call, remote: uiCtx.remote.nexusVoice, open: () => { P.closeTopModal(document); ctx.uiWorkspace.openSession(SUPERVISOR) } }),
            }, CallBar))
            uiCtx.slots.inject('shell.overlay', () => uiCtx.slots.register({
              name: 'shell.overlay', id: 'nexus-voice', locale: 'nexus',
              inject: () => ({ call, remote: uiCtx.remote.nexusVoice, open: () => { P.closeTopModal(document); ctx.uiWorkspace.openSession(SUPERVISOR) }, floating: true }),
            }, CallBar))
            uiCtx.remote.nexusVoice.claimStartup().then(async response => {
              if (disposed) return
              if (!response.ok) { call.set('failed', response.error.code); return }
              if (!response.value) return
              call.autoPending = true
              await uiCtx.uiWorkspace.openSession(SUPERVISOR)
              if (disposed) { call.autoPending = false; return }
              call.set(call.state, call.code)
            }).catch(error => call.set('failed', error?.code ?? 'UNAVAILABLE'))
          })
        })
      },
    }
  },
})
