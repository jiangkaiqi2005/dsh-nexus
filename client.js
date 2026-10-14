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
      if (value?.type === 'ready' && Object.keys(value).length === 1) return value
      if (value && typeof value === 'object' && Object.keys(value).length === 2 && ((value.type === 'audio' && isAudio(value.audio)) || (['played', 'hangup'].includes(value.type) && Number.isSafeInteger(value.samples) && value.samples >= 0))) return value
      throw new TypeError('nexusVoice/call uplink must be { type: "audio", audio: base64 } or { type: "played" | "hangup", samples }')
    }
    const frame = value => {
      if (value?.type === 'audio' && isAudio(value.audio)) return value
      if (value?.type === 'flush' && Object.keys(value).length === 1) return value
      if (value?.type === 'activity' && ['thinking', 'reading', 'idle', 'failed'].includes(value.state) && (value.code === undefined || typeof value.code === 'string')) return value
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
      constructor() { this.state = 'idle'; this.activity = 'idle'; this.activityCode = undefined; this.mode = 'realtime'; this.code = undefined; this.played = 0; this.flushes = 0; this.discarded = 0; this.listeners = new Set(); this.attempt = undefined; this.autoPending = false }
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
        const processor = capture.createScriptProcessor(2048, 1, 1)
        cleanups.push(() => { processor.disconnect(); source.disconnect() })
        processor.onaudioprocess = event => {
          if (!current() || this.state !== 'live' || this.mode === 'cascade') return
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
        let pendingActivity = 'idle'
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
          mediaReady = true
          handle.send({ type: 'ready' })
          for (let nextFrame = await frames.next(); !nextFrame.done; nextFrame = await frames.next()) {
            const frame = nextFrame.value
            if (!current()) continue // Let the Host consume the final report before disposing this stream.
            if (frame.type === 'state' && ['connecting', 'live'].includes(frame.state)) { this.mode = frame.mode ?? 'realtime'; this.set(frame.state) }
            else if (frame.type === 'state' && frame.state === 'failed') return end('failed', frame.code)
            else if (frame.type === 'activity') {
              pendingActivity = frame.state
              retire(playback.currentTime)
              this.activity = nodes.length && frame.state !== 'failed' ? 'reading' : frame.state
              this.activityCode = frame.code
              this.set(this.state, this.code)
            }
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
              node.onended = () => { if (!current()) return; retire(playback.currentTime); if (!nodes.length && pendingActivity !== 'reading' && this.activity === 'reading') { this.activity = pendingActivity; this.set(this.state, this.code) } }
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
        this.activity = 'idle'
        this.activityCode = undefined
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

    function CallBar({ sessionId, call, remote, t, floating = false }) {
      const [, render] = React.useReducer(count => count + 1, 0)
      React.useEffect(() => call.subscribe(render), [call])
      React.useEffect(() => {
        if (sessionId === SUPERVISOR && call.autoPending) { call.autoPending = false; call.start(remote) }
      }, [sessionId, call, remote, call.autoPending])
      if (floating ? call.state === 'idle' : sessionId !== SUPERVISOR || call.state !== 'idle') return null
      const busy = call.active
      return h('div', {
        'data-nexus-voice': '', 'data-state': call.state, 'data-activity': call.activity, 'data-played-samples': call.played, 'data-flushes': call.flushes, 'data-discarded-samples': call.discarded,
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 13, ...(floating ? { position: 'absolute', bottom: 20, right: 24, pointerEvents: 'auto', background: 'var(--color-background, Canvas)', border: '1px solid currentColor', borderRadius: 8 } : {}) },
      },
      h('span', { role: 'status' }, t(`state-${call.state}`) + (call.state === 'live' && call.activity !== 'idle' ? ` · ${t(`activity-${call.activity}`)}${call.activityCode ? ` (${call.activityCode})` : ''}` : '') + (call.code && !busy ? ` (${call.code})` : '')),
      h('button', {
        type: 'button', onClick: () => { call.autoPending = false; busy ? call.hangup() : call.start(remote) },
        style: { color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 6, cursor: 'pointer', padding: '2px 10px' },
      }, busy ? t('hangup') : t('start')))
    }

    // As DEFAULT_SUMMARY_MODEL in src/compaction.ts: the summary model while the setting is empty.
    const DEFAULT_SUMMARY_MODEL = 'deepseek-account/deepseek-flash'
    // As lowestEffort in src/compaction.ts: an effort that turns thinking off, then minimal, then low.
    const lowestEffort = efforts => {
      const named = pattern => efforts.find(effort => pattern.test(effort.id) || pattern.test(effort.name))
      return named(/^(?:none|off|disabled?)$/i) ?? named(/^minimal$/i) ?? named(/^low$/i)
    }

    function Settings({ form, catalog, t }) {
      const snapshot = React.useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
      const [error, setError] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [budget, setBudget] = React.useState()
      const [models, setModels] = React.useState()
      const [speech, setSpeech] = React.useState({})
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
      return h('div', { style: { padding: 16 } },
        h('h2', null, 'Nexus'),
        h('label', { style: { display: 'block', marginBottom: 12 } }, t('voice-mode'), ' ', h('select', {
          value: snapshot.value?.voiceMode ?? 'cascade', disabled,
          onChange: event => save('voiceMode', event.target.value),
        }, h('option', { value: 'cascade' }, t('cascade')), h('option', { value: 'realtime' }, 'Realtime'))),
        h('p', null, t('voice-mode-hint')),
        ...[['ttsEndpoint', 'tts-endpoint', 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'], ['ttsModel', 'tts-model', 'qwen-audio-3.1-tts-flash'], ['ttsVoice', 'tts-voice', 'longanhuan_v3.1']].map(([key, label, fallback]) => h('label', { key, style: { display: 'block', marginBottom: 12 } }, t(label), ' ', h('input', {
          type: 'text', value: speech[key] ?? snapshot.value?.[key] ?? fallback, disabled,
          onChange: event => setSpeech({ ...speech, [key]: event.target.value }),
          onBlur: () => { if (speech[key] !== undefined) { const value = speech[key].trim(); setSpeech(current => { const next = { ...current }; delete next[key]; return next }); if (value && value !== snapshot.value?.[key]) save(key, value) } },
        }))),
        h('label', null, h('input', {
          type: 'checkbox', checked: snapshot.value?.autoVoice ?? false, disabled,
          onChange: event => save('autoVoice', event.target.checked),
        }), t('auto-voice')),
        h('p', null, t('next-startup')),
        h('label', { style: { display: 'block', marginTop: 12 } }, t('compaction-budget'), ' ', h('input', {
          type: 'number', min: 1, step: 1, value: budget ?? savedBudget, disabled,
          onChange: event => setBudget(event.target.value), onBlur: commitBudget,
          onKeyDown: event => { if (event.key === 'Enter') commitBudget() },
        })),
        h('label', { style: { display: 'block', marginTop: 12 } }, t('summary-model'), ' ', h('select', {
          value: summaryModel, disabled,
          onChange: event => save('summaryModel', event.target.value),
        }, h('option', { value: '' }, `${t('summary-default')} (${DEFAULT_SUMMARY_MODEL})`), ...routes.map(route => h('option', { key: route.value, value: route.value }, route.label)))),
        h('label', { style: { display: 'block', marginTop: 12 } }, t('summary-effort'), ' ', h('select', {
          value: effort, disabled: disabled || !efforts.length,
          onChange: event => save('summaryReasoningEffort', event.target.value),
        }, ...effortOptions)),
        h('p', null, t('compaction-hint')),
        error ? h('p', { role: 'alert' }, t('save-failed')) : null)
    }

    return {
      inject: ['slots', 'uiWorkspace', 'locale'],
      apply(ctx) {
        ctx.locale.register('nexus', 'en', { open: 'Open Nexus', 'voice-mode': 'Voice mode', cascade: 'Cascade', 'voice-mode-hint': 'Changes apply on the next call. Cascade uses the Harness default model.', 'tts-endpoint': 'Speech synthesis endpoint', 'tts-model': 'Speech synthesis model', 'tts-voice': 'Speech voice', 'activity-thinking': 'Thinking…', 'activity-reading': 'Reading aloud…', 'activity-failed': 'Speech synthesis failed', start: 'Start voice', hangup: 'Hang up', 'auto-voice': 'Enter Nexus voice automatically when Harness starts', 'next-startup': 'Changes apply on the next Harness startup.', 'save-failed': 'Could not save the setting.', 'compaction-budget': 'Main conversation compaction budget (tokens)', 'summary-model': 'Compaction summary model', 'summary-default': 'Default', 'summary-effort': 'Summary reasoning effort', 'effort-lowest': 'Lowest', 'effort-model-default': 'Model default', 'effort-none': 'This model offers no reasoning efforts', 'compaction-hint': 'When the main conversation exceeds the budget, older history is summarized between turns; budget, summary model and reasoning effort apply immediately. Summaries use DeepSeek Flash unless you choose another model, at the lowest reasoning effort the model offers. Known limits: a reasoning model summarizes markedly slower, and its reasoning counts toward the output limit. Keep the budget well above the fixed part of each supervisor request (system prompt, tool definitions and similar): summarizing cannot bring a request below it, so automatic compaction is skipped when it would barely help. During automatic compaction the conversation shows the general running status, as native automatic compaction does.', ...states(STATES.en) })
        ctx.locale.register('nexus', 'zh', { open: '打开 Nexus', 'voice-mode': '语音模式', cascade: '级联', 'voice-mode-hint': '更改在下一次接通时生效。级联主管跟随 Harness 默认模型。', 'tts-endpoint': '语音合成端点', 'tts-model': '语音合成型号', 'tts-voice': '语音合成音色', 'activity-thinking': '思考中', 'activity-reading': '朗读中', 'activity-failed': '语音合成失败', start: '接通语音', hangup: '挂断', 'auto-voice': '启动 Harness 后自动进入 Nexus 语音', 'next-startup': '更改在下一次 Harness 启动时生效。', 'save-failed': '设置保存失败。', 'compaction-budget': '主会话压缩预算（token）', 'summary-model': '压缩摘要模型', 'summary-default': '默认', 'summary-effort': '摘要思考强度', 'effort-lowest': '最低', 'effort-model-default': '模型默认', 'effort-none': '该模型不提供思考强度选项', 'compaction-hint': '主会话超过预算时，会在轮次之间总结较早的历史；预算、摘要模型与思考强度立即生效。未另选时由 DeepSeek Flash 写摘要，并以该模型可用的最低思考强度运行。已知局限：思考型模型摘要明显更慢，思考内容计入输出上限；预算应明显高于主管每次请求的固定开销（系统提示、工具定义等），摘要无法让请求低于这部分，压缩几乎无效时会跳过自动压缩；自动压缩期间会话显示通用的运行状态，与原生自动压缩一致。', ...states(STATES.zh) })
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
          inject: () => ({ open: () => ctx.uiWorkspace.openSession(SUPERVISOR) }),
        }, ({ open, t, wide }) => h('button', {
          type: 'button', title: t('open'), 'aria-label': t('open'), onClick: open,
          style: { color: 'inherit', background: 'transparent', border: 0, cursor: 'pointer', padding: 8 },
        }, wide ? 'Nexus' : 'N')))
        const call = new Call()
        ctx.effect(() => () => { call.autoPending = false; call.hangup() })
        ctx.inject(['remote'], async remoteCtx => {
          await remoteCtx.remote.$mount(CONTRIBUTION)
          remoteCtx.inject(['remote.nexusVoice', 'slots'], uiCtx => {
            let disposed = false
            uiCtx.effect(() => () => { disposed = true })
            uiCtx.slots.inject('conversation.input.dock', () => uiCtx.slots.register({
              name: 'conversation.input.dock', id: 'nexus-voice', locale: 'nexus',
              inject: sessionId => ({ sessionId, call, remote: uiCtx.remote.nexusVoice }),
            }, CallBar))
            uiCtx.slots.inject('shell.overlay', () => uiCtx.slots.register({
              name: 'shell.overlay', id: 'nexus-voice', locale: 'nexus',
              inject: () => ({ call, remote: uiCtx.remote.nexusVoice, floating: true }),
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
