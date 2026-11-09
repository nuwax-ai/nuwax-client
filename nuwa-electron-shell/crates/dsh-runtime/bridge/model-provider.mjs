import { Service } from '@deepseek-ai/cordis'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'

export const name = 'nuwax-models'
export const inject = ['llm', 'credentials']

/** Model credentials here authorize only the current local broker generation. */
export async function apply(ctx) {
  const broker = process.env.NUWAX_DSH_BROKER
  const token = process.env.NUWAX_DSH_RUN_TOKEN
  if (!broker || !token) throw new Error('Nuwax model broker is unavailable')
  const response = await fetch(new URL('/catalog', broker), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Nuwax model catalog failed (${response.status})`)
  const { models } = await response.json()
  if (!Array.isArray(models) || models.length === 0) throw new Error('Authorize at least one Nuwax model')
  const providers = {}
  for (const model of models) {
    providers[model.provider] = {
      displayName: model.name,
      api: model.api,
      baseURL: new URL(`/model/${model.id}${model.api === 'openai-completions' ? '/v1' : ''}`, broker).href,
      apiKeyEnv: 'NUWAX_DSH_RUN_TOKEN',
      models: [{
        id: model.model, name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
      }],
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    }
  }
  // The platform owns this provider configuration. Applying the public adapter
  // with a fixed configuration avoids a writable, user-added BYOK route.
  piAi.apply(ctx, piAi.Config({ providers }))
  const allowed = new Set(models.map(model => model.provider + '/' + model.model))
  ctx.on('llm/stream', (options, next) => {
    if (!allowed.has(options.provider + '/' + options.model)) throw new Error('Select an authorized Nuwax model')
    return next()
  })
  class NuwaxModels extends Service {
    constructor(context) { super(context, 'nuwaxModels'); this.models = models }
  }
  ctx.plugin(NuwaxModels)
}
