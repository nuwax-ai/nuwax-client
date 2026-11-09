/** DSH currently ships Chinese and English dictionaries. */
export function dshLanguage(language) {
  return typeof language === 'string' && /^zh(?:-|$)/i.test(language.trim()) ? 'zh' : 'en'
}

/** Keep the upstream live locale field derived from the shell, including after a Client writes its old preference. */
export function createLocaleSync(ctx) {
  const settings = ctx.get('settings')
  if (!settings) throw new Error('DSH locale settings are unavailable')
  let desired = 'en', disposed = false, queue = Promise.resolve()
  const update = (language = desired) => {
    desired = dshLanguage(language)
    const result = queue.then(async () => {
      if (disposed) return
      const current = settings.describe({ redactSecrets: true }).find(value => value.ns === 'locale')
      if (!current) throw new Error('DSH locale settings are unavailable')
      if (current.value?.preference !== desired) await settings.update('locale', { preference: desired })
    })
    queue = result.catch(() => {})
    return result
  }
  const off = ctx.on('settings/document-updated', namespace => {
    if (namespace === 'locale') void update().catch(() => { ctx.logger.warn('Nuwax interface language could not be synchronized') })
  })
  return { update, dispose() { disposed = true; off() } }
}
