import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhTW from './zh-TW.json'
import en from './en.json'

export const LANG_KEY = 'mhc.lang'
export const SUPPORTED_LANGS = ['zh-TW', 'en'] as const
export type Lang = (typeof SUPPORTED_LANGS)[number]

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved && (SUPPORTED_LANGS as readonly string[]).includes(saved)) return saved as Lang
  } catch {
    /* ignore */
  }
  return 'zh-TW'
}

i18n.use(initReactI18next).init({
  resources: { 'zh-TW': { translation: zhTW }, en: { translation: en } },
  lng: initialLang(),
  fallbackLng: 'zh-TW',
  interpolation: { escapeValue: false },
})

export function setLang(lang: Lang) {
  i18n.changeLanguage(lang)
  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lang
}

export default i18n
