import { app, shell, BrowserWindow, ipcMain, desktopCapturer } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { checkAndRequestPermissions } from './permission'
import Store from 'electron-store'
import { AIClient } from '../core/ai-client'
import { DesktopDevice } from '../core/device'
import { RPADevice } from '../core/rpa-device'
import { BoxSelectDevice } from '../core/box-select-device'
import { RuntimeHost } from '../core/runtime-host'
import {
  createInitialGenericChannelState,
  GenericChannelSession
} from '../core/generic-channel-session'
import { AppType, BoxRegions, CaptureStrategy, isWechatLike } from '../core/rpa/types'
import { runBoxSelectWizard, type WizardStepKey } from './overlay-window'
import {
  BUILTIN_DOUBAO_PROVIDER_ID,
  getBuiltinDoubaoInstalledInfo,
  getBuiltinDoubaoManifestForUi,
  getInstalledProviderManifest,
  installProviderFromUrl,
  InstalledProviderInfo,
  loadBuiltinDoubaoProvider,
  loadInstalledProvider
} from './provider-bundle'
import {
  SkillEngineController,
  SkillPauseResult,
  SkillStartResult,
  startSkillServer,
  stopSkillServer
} from './skill-server'
const StoreClass = typeof Store === 'function' ? Store : ((Store as any).default as typeof Store)

const FIXED_ARK_MODEL = 'doubao-seed-2-0-lite-260215'
const FIXED_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

interface PerAppCapture {
  strategy: CaptureStrategy
  regions: BoxRegions | null
}

interface AppSettings {
  locale: 'zh' | 'en'
  appType: AppType
  vision: {
    apiKey: string
  }
  chatProvider: {
    manifestUrl: string
    installed: InstalledProviderInfo | null
    config: Record<string, any>
  }
  // 默认抓取策略（仅当 appType 没有 per-app 覆盖时生效）
  defaultCaptureStrategy: CaptureStrategy
  // 每个 appType 独立保存的策略 + 框选区域
  capture: Partial<Record<AppType, PerAppCapture>>
}

const settingsStore = new StoreClass({
  name: 'settings',
  defaults: {
    locale: 'zh',
    appType: 'wechat',
    vision: { apiKey: '' },
    chatProvider: {
      manifestUrl: '',
      installed: null,
      config: {}
    },
    defaultCaptureStrategy: 'auto',
    capture: {}
  }
})

let runtime: RuntimeHost<ReturnType<typeof createInitialGenericChannelState>> | null = null
let runtimeDevice: DesktopDevice | null = null

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 360,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // 检查和请求 macOS 需要的权限
  await checkAndRequestPermissions()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // ── Settings 持久化 ──
  ipcMain.handle('settings:getAll', async () => {
    return normalizeSettings(settingsStore.store)
  })

  ipcMain.handle('settings:get', async (_event, key: string) => {
    const settings = normalizeSettings(settingsStore.store)
    return (settings as Record<string, any>)[key]
  })

  ipcMain.handle('settings:set', async (_event, data: Record<string, any>) => {
    const current = normalizeSettings(settingsStore.store)
    const next = {
      ...current,
      ...data,
      vision: {
        ...current.vision,
        ...(data.vision || {})
      },
      chatProvider: {
        ...current.chatProvider,
        ...(data.chatProvider || {}),
        config: {
          ...current.chatProvider.config,
          ...(data.chatProvider?.config || {})
        }
      },
      capture: {
        ...current.capture,
        ...(data.capture || {})
      }
    } satisfies AppSettings

    settingsStore.set(next as any)
    return { success: true }
  })

  ipcMain.handle('provider:installFromUrl', async (_event, manifestUrl: string) => {
    try {
      const result = await installProviderFromUrl(manifestUrl)
      const current = normalizeSettings(settingsStore.store)
      settingsStore.set({
        ...current,
        chatProvider: {
          ...current.chatProvider,
          manifestUrl,
          installed: result.installed,
          config: withSchemaDefaults(result.manifest.configSchema, current.chatProvider.config)
        }
      } as any)

      return {
        success: true,
        installed: result.installed,
        manifest: result.manifest
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('provider:getInstalled', async () => {
    const settings = normalizeSettings(settingsStore.store)

    // 用户安装过自定义 provider：原样返回
    if (settings.chatProvider.installed) {
      const manifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      return {
        installed: settings.chatProvider.installed,
        manifest,
        isBuiltinDefault: false
      }
    }

    // 没装过 → 回退到内置 doubao（apiKey 字段已剥离，使用视觉密钥）
    const installed = await getBuiltinDoubaoInstalledInfo()
    const manifest = await getBuiltinDoubaoManifestForUi()
    return {
      installed,
      manifest,
      isBuiltinDefault: true
    }
  })

  // ── Runtime / Session IPC（沿用 legacy engine:* 通道名） ──
  ipcMain.handle('engine:start', async (_event, config) => {
    const result = await startEngineCore(config)
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  ipcMain.handle('engine:stop', async (_event, reason?: string) => {
    const result = await stopEngineCore(reason || 'ipc_stop')
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  ipcMain.handle('engine:status', async () => {
    return { running: runtime?.isRunning() ?? false }
  })

  ipcMain.handle('engine:updateConfig', async (_event, config) => {
    const settings = normalizeSettings(config || settingsStore.store)
    if (runtimeDevice) {
      // setApiKey 在 BoxSelectDevice 上是 no-op，对 RPADevice 才生效。
      runtimeDevice.setApiKey(settings.vision.apiKey)
      runtimeDevice.setAppType(settings.appType)
    }
    if (runtime) {
      runtime.updateAppType(settings.appType)
    }
    return { success: true }
  })

  ipcMain.handle('engine:testConnection', async (_event, config) => {
    const apiKey = config?.apiKey || normalizeSettings(settingsStore.store).vision.apiKey
    const client = new AIClient({
      apiKey,
      model: FIXED_ARK_MODEL,
      baseURL: FIXED_ARK_BASE_URL
    })
    return client.testConnection()
  })

  // ── Capture / 框选向导 IPC ──

  ipcMain.handle(
    'capture:openSetupWizard',
    async (_event, args: { appType: AppType; steps?: WizardStepKey[] }) => {
      const settings = normalizeSettings(settingsStore.store)
      const appType = coerceAppType(args?.appType)
      const prefill = settings.capture[appType]?.regions ?? null

      const result = await runBoxSelectWizard({ appType, steps: args?.steps, prefill })
      if (!result.ok || !result.regions) {
        return { success: false, reason: result.reason || 'cancelled' }
      }

      // 持久化区域到 settings.capture[appType]，但保留已有 strategy（默认 'auto'）
      const current = normalizeSettings(settingsStore.store)
      const next: AppSettings = {
        ...current,
        capture: {
          ...current.capture,
          [appType]: {
            strategy: current.capture[appType]?.strategy ?? 'auto',
            regions: result.regions
          }
        }
      }
      settingsStore.set(next as any)
      notifyCaptureRegionsUpdated(appType, result.regions)
      return { success: true, regions: result.regions }
    }
  )

  ipcMain.handle('capture:getRegions', async (_event, appType: AppType) => {
    const settings = normalizeSettings(settingsStore.store)
    return settings.capture[coerceAppType(appType)]?.regions ?? null
  })

  ipcMain.handle('capture:resetRegions', async (_event, appType: AppType) => {
    const current = normalizeSettings(settingsStore.store)
    const key = coerceAppType(appType)
    const next: AppSettings = {
      ...current,
      capture: {
        ...current.capture,
        [key]: { strategy: current.capture[key]?.strategy ?? 'auto', regions: null }
      }
    }
    settingsStore.set(next as any)
    notifyCaptureRegionsUpdated(key, null)
    return { success: true }
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('capture-screen', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      if (sources && sources.length > 0) {
        return sources[0].thumbnail.toDataURL()
      }
      return null
    } catch (error) {
      console.error('Screen capture failed:', error)
      return null
    }
  })

  // ── 测试入口：VLM 并行 vs 串行 ──
  ipcMain.handle('test:vlm-parallel', async () => {
    const apiKey = normalizeSettings(settingsStore.store).vision.apiKey
    if (!apiKey) return { error: '请先在设置中填写视觉接口密钥' }
    const { runVlmParallelTest } = await import('../core/rpa/tests/test-vlm-parallel')
    return await runVlmParallelTest(apiKey, 'wechat')
  })

  // ── Skill HTTP Server（OpenClaw 远程启动 / 暂停接入点） ──
  startSkillServer(skillEngineController)

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopSkillServer()
})

// ── 引擎启动 / 暂停核心逻辑（IPC 与 Skill HTTP Server 共用） ──

async function startEngineCore(rawConfig?: any): Promise<SkillStartResult> {
  if (runtime?.isRunning()) {
    return { ok: false, reason: 'already_running', message: '引擎已在运行中' }
  }

  try {
    const settings = normalizeSettings(rawConfig || settingsStore.store)
    const appType: AppType = settings.appType || 'wechat'
    const startupStrategy = resolveSettingsStrategy(appType, settings)
    const providerNeedsVisionKey =
      !settings.chatProvider.installed ||
      settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
    const needsVisionKey = startupStrategy === 'vlm' || providerNeedsVisionKey

    if (needsVisionKey && !settings.vision.apiKey) {
      return { ok: false, reason: 'no_vision_key', message: '请先填写视觉接口密钥' }
    }

    // 没有自定义 provider → 走内置 doubao，使用视觉密钥
    let provider
    if (!settings.chatProvider.installed) {
      const loaded = await loadBuiltinDoubaoProvider({
        ...settings.chatProvider.config,
        apiKey: settings.vision.apiKey
      })
      provider = loaded.provider
    } else {
      const installedManifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      // doubao（无论是用户主动装的还是内置的）apiKey 由视觉密钥共享提供，不强校验
      const isDoubao = settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
      const required = (installedManifest?.configSchema?.required || []).filter(
        (key) => !(isDoubao && key === 'apiKey')
      )
      const missing = required.find((key) => {
        const value = settings.chatProvider.config?.[key]
        return value === undefined || value === null || value === ''
      })
      if (missing) {
        return {
          ok: false,
          reason: 'missing_required_field',
          message: `缺少必填配置: ${missing}`
        }
      }

      const effectiveConfig = isDoubao
        ? { ...settings.chatProvider.config, apiKey: settings.vision.apiKey }
        : settings.chatProvider.config

      const loaded = await loadInstalledProvider(settings.chatProvider.installed, effectiveConfig)
      provider = loaded.provider
    }

    const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
    const log = (type: 'thinking' | 'reply' | 'skip' | 'error', content: string): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:log', { type, content })
      }
    }

    let device: DesktopDevice
    let strategy: CaptureStrategy
    try {
      const built = await buildDevice(appType, settings, settings.vision.apiKey, log)
      device = built.device
      strategy = built.strategy
    } catch (err: any) {
      const message = err?.message || String(err)
      if (message === 'user_cancelled_box_select_wizard') {
        return { ok: false, reason: 'wizard_cancelled', message: '已取消框选，引擎未启动' }
      }
      throw err
    }
    log('thinking', `已选用抓取策略：${strategy}`)
    runtimeDevice = device

    const channel = new GenericChannelSession(device)
    runtime = new RuntimeHost({
      appType,
      channel,
      provider,
      initialState: createInitialGenericChannelState(),
      onLog: log
    })

    runtime.startSession().catch((err: any) => {
      console.error('[Main] Runtime session error:', err)
    })

    notifyEngineStateChanged('running')

    return { ok: true }
  } catch (error: any) {
    return {
      ok: false,
      reason: 'engine_failed',
      message: error?.message || String(error)
    }
  }
}

async function stopEngineCore(stopReason: string): Promise<SkillPauseResult> {
  if (!runtime?.isRunning()) {
    return { ok: false, reason: 'not_running', message: '引擎未运行' }
  }
  try {
    await runtime.stopSession(stopReason)
    notifyEngineStateChanged('idle')
    return { ok: true }
  } catch (error: any) {
    return {
      ok: false,
      reason: 'pause_failed',
      message: error?.message || String(error)
    }
  }
}

/** 通知 Renderer 引擎状态变化（让 UI 在远程启停时同步切换） */
function notifyEngineStateChanged(status: 'running' | 'idle'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('engine:state', { status })
    }
  }
}

/** 通知 Renderer：某个 appType 的框选区域被向导/重置更新了，UI 上的 chip 立即重渲染。 */
function notifyCaptureRegionsUpdated(appType: AppType, regions: BoxRegions | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('capture:regions-updated', { appType, regions })
    }
  }
}

/**
 * 选取实际生效的 capture strategy。
 * 用户在 settings 里给 appType 显式设置过策略，就用它；否则用全局默认；
 * 全局默认是 'auto' 时，wechat/wework 优先 VLM，其它直接 box-select。
 */
function resolveEffectiveStrategy(
  appType: AppType,
  perAppStrategy: CaptureStrategy,
  defaultStrategy: CaptureStrategy
): CaptureStrategy {
  const effective = perAppStrategy === 'auto' ? defaultStrategy : perAppStrategy
  if (effective === 'auto') {
    return isWechatLike(appType) ? 'vlm' : 'box-select'
  }
  return effective
}

function resolveSettingsStrategy(appType: AppType, settings: AppSettings): CaptureStrategy {
  const perApp = settings.capture[appType] ?? { strategy: 'auto' as CaptureStrategy, regions: null }
  return resolveEffectiveStrategy(appType, perApp.strategy, settings.defaultCaptureStrategy)
}

/**
 * 把 capture 配置 + strategy 解析成具体设备实例。
 * VLM 和 box-select 只决定"如何测量 LayoutCache"，后续运行统一消费 LayoutCache。
 * 本轮不做 VLM 失败自动 fallback；VLM 测量失败由 session bootstrap 报错停止。
 */
async function buildDevice(
  appType: AppType,
  settings: AppSettings,
  apiKey: string,
  log: (type: 'thinking' | 'reply' | 'skip' | 'error', content: string) => void
): Promise<{ device: DesktopDevice; strategy: CaptureStrategy }> {
  const perApp = settings.capture[appType] ?? { strategy: 'auto' as CaptureStrategy, regions: null }
  const effective = resolveSettingsStrategy(appType, settings)

  if (effective === 'vlm') {
    const rpa = new RPADevice()
    rpa.setAppType(appType)
    rpa.setApiKey(apiKey)
    return { device: rpa, strategy: 'vlm' }
  }

  // box-select 路线：缺区域则拉向导
  let regions = perApp.regions
  if (!regions) {
    log('thinking', `首次配置 ${appType}：请框选 3 个关键区域`)
    const wizardResult = await runBoxSelectWizard({ appType, prefill: null })
    if (!wizardResult.ok || !wizardResult.regions) {
      throw new Error('user_cancelled_box_select_wizard')
    }
    regions = wizardResult.regions
    persistRegionsAndStickyStrategy(appType, regions, perApp.strategy)
  }
  return { device: new BoxSelectDevice(regions), strategy: 'box-select' }
}

/** 把向导产出的 regions 写回 settings，并保留当前策略配置。 */
function persistRegionsAndStickyStrategy(
  appType: AppType,
  regions: BoxRegions,
  strategy: CaptureStrategy
): void {
  const current = normalizeSettings(settingsStore.store)
  const next: AppSettings = {
    ...current,
    capture: {
      ...current.capture,
      [appType]: { strategy, regions }
    }
  }
  settingsStore.set(next as any)
  notifyCaptureRegionsUpdated(appType, regions)
}

const skillEngineController: SkillEngineController = {
  start: () => startEngineCore(),
  pause: () => stopEngineCore('skill_pause'),
  isRunning: () => runtime?.isRunning() ?? false
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

const VALID_APP_TYPES: AppType[] = [
  'wechat',
  'wework',
  'dingtalk',
  'lark',
  'slack',
  'telegram',
  'generic'
]
const VALID_CAPTURE_STRATEGIES: CaptureStrategy[] = ['auto', 'vlm', 'box-select']

function coerceAppType(raw: unknown): AppType {
  return typeof raw === 'string' && (VALID_APP_TYPES as string[]).includes(raw)
    ? (raw as AppType)
    : 'wechat'
}

function coerceStrategy(raw: unknown, fallback: CaptureStrategy = 'auto'): CaptureStrategy {
  return typeof raw === 'string' && (VALID_CAPTURE_STRATEGIES as string[]).includes(raw)
    ? (raw as CaptureStrategy)
    : fallback
}

function coerceRect(raw: unknown): BoxRegions['contactList'] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = Number(r.x),
    y = Number(r.y),
    w = Number(r.width),
    h = Number(r.height)
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null
  return { x, y, width: w, height: h }
}

function coerceRegions(raw: unknown): BoxRegions | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const contactList = coerceRect(r.contactList)
  const chatMain = coerceRect(r.chatMain)
  const inputBox = coerceRect(r.inputBox)
  if (!contactList || !chatMain || !inputBox) return null
  return {
    contactList,
    chatMain,
    inputBox,
    unreadIndicator: coerceRect(r.unreadIndicator),
    displayId: typeof r.displayId === 'number' ? r.displayId : undefined,
    scaleFactor: typeof r.scaleFactor === 'number' ? r.scaleFactor : undefined,
    capturedAt: typeof r.capturedAt === 'number' ? r.capturedAt : Date.now()
  }
}

function normalizeCapture(raw: unknown): Partial<Record<AppType, PerAppCapture>> {
  const out: Partial<Record<AppType, PerAppCapture>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of VALID_APP_TYPES) {
    const value = (raw as Record<string, unknown>)[key]
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    out[key] = {
      strategy: coerceStrategy(v.strategy),
      regions: coerceRegions(v.regions)
    }
  }
  return out
}

function normalizeSettings(raw: any): AppSettings {
  const oldApiKey = typeof raw?.apiKey === 'string' ? raw.apiKey : ''
  const oldModel = typeof raw?.model === 'string' && raw.model ? raw.model : FIXED_ARK_MODEL
  const oldSystemPrompt = typeof raw?.systemPrompt === 'string' ? raw.systemPrompt : ''
  const rawProviderConfig =
    raw?.chatProvider?.config && typeof raw.chatProvider.config === 'object'
      ? { ...raw.chatProvider.config }
      : {}

  // Keep arbitrary provider config keys, and only backfill legacy volcengine fields for old persisted settings.
  if (rawProviderConfig.apiKey === undefined && oldApiKey) {
    rawProviderConfig.apiKey = oldApiKey
  }
  if (rawProviderConfig.model === undefined && oldModel) {
    rawProviderConfig.model = oldModel
  }
  if (rawProviderConfig.systemPrompt === undefined && oldSystemPrompt) {
    rawProviderConfig.systemPrompt = oldSystemPrompt
  }

  return {
    locale: raw?.locale === 'en' ? 'en' : 'zh',
    appType: coerceAppType(raw?.appType),
    vision: {
      apiKey: raw?.vision?.apiKey || oldApiKey || ''
    },
    chatProvider: {
      manifestUrl: raw?.chatProvider?.manifestUrl || raw?.providerManifestUrl || '',
      installed: raw?.chatProvider?.installed || null,
      config: rawProviderConfig
    },
    defaultCaptureStrategy: coerceStrategy(raw?.defaultCaptureStrategy, 'auto'),
    capture: normalizeCapture(raw?.capture)
  }
}

function withSchemaDefaults(
  schema: { properties: Record<string, { default?: unknown }> },
  current: Record<string, any>
): Record<string, any> {
  const next = { ...current }
  for (const [key, field] of Object.entries(schema.properties || {})) {
    if (next[key] === undefined && field.default !== undefined) {
      next[key] = field.default
    }
  }
  return next
}
