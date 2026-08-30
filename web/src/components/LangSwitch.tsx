import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGS, setLang, type Lang } from '../i18n'

export function LangSwitch() {
  const { t, i18n } = useTranslation()
  return (
    <select
      aria-label={t('lang.switch')}
      className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
      value={i18n.language}
      onChange={(e) => setLang(e.target.value as Lang)}
    >
      {SUPPORTED_LANGS.map((l) => (
        <option key={l} value={l}>
          {t(`lang.${l}`)}
        </option>
      ))}
    </select>
  )
}
