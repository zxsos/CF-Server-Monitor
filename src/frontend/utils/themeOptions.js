export const normalizeThemeOptions = (options) => {
  return options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {}
}

const MIKUS_ASSET_BASE = '/mikus'
const MIKUS_SAKURA_ID = 'mikus-global-sakura-background'
const MIKUS_SAKURA_COUNT = 15

const MIKUS_MOBILE_SAKURA_COUNT = 10

export const isThemeOptionEnabled = (options, key) => {
  const normalizedOptions = normalizeThemeOptions(options)
  if (!Object.prototype.hasOwnProperty.call(normalizedOptions, key)) return false

  const value = normalizedOptions[key]
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase()
    if (!normalizedValue) return false
    return !['0', 'false', 'off', 'no', 'disable', 'disabled'].includes(normalizedValue)
  }

  return true
}

export const isMikusThemeEnabled = (options) => isThemeOptionEnabled(options, 'mikus')

export const getMikusAssetUrl = (filename) => {
  const normalizedFilename = String(filename || '').replace(/^\/+/, '')
  return `${MIKUS_ASSET_BASE}/${normalizedFilename}`
}

const ensureMikusSakuraBackground = () => {
  if (typeof document === 'undefined' || !document.body) return
  if (document.getElementById(MIKUS_SAKURA_ID)) return

  const background = document.createElement('div')
  background.id = MIKUS_SAKURA_ID
  background.className = 'mikus-global-sakura'
  background.setAttribute('aria-hidden', 'true')

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const sakuraCount = viewportWidth <= 768 ? MIKUS_MOBILE_SAKURA_COUNT : MIKUS_SAKURA_COUNT
  for (let index = 0; index < sakuraCount; index += 1) {
    const petal = document.createElement('span')
    petal.className = 'mikus-background-petal'
    background.appendChild(petal)
  }

  document.body.insertBefore(background, document.body.firstChild)
}

const removeMikusSakuraBackground = () => {
  if (typeof document === 'undefined') return
  document.getElementById(MIKUS_SAKURA_ID)?.remove()
}

export const setMikusThemeClass = (enabled) => {
  if (typeof document === 'undefined') return
  const shouldEnable = Boolean(enabled)
  document.body.classList.toggle('mikus-theme', shouldEnable)
  if (shouldEnable) {
    ensureMikusSakuraBackground()
  } else {
    removeMikusSakuraBackground()
  }
}

export const applyMikusThemeOptions = (options) => {
  setMikusThemeClass(isMikusThemeEnabled(options))
}
