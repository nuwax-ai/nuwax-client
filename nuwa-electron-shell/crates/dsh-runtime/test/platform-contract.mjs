import assert from 'node:assert/strict'
import { createModelBroker, modelDescriptor } from '../model-broker.mjs'

/** Explicit acceptance only: request is a logged-in platform channel. Keys live
 * in this invocation and are always removed; no credentials enter evidence. */
export async function verifyPlatformModels(request, fetchModel = globalThis.fetch, modelIds) {
  const [catalog, tenant] = await Promise.all([Promise.all(['System','Space'].map(tab=>request('/api/model/my?tab='+tab))).then(values=>[...new Map(values.flat().map(value=>[value.id,value])).values()]), request('/api/tenant/config')])
  const models = catalog.filter(value => modelIds.includes(value.id)).map(modelDescriptor).filter(Boolean)
  assert.equal(models.length, 2, 'Acceptance models are not available in this tenant')
  let key, broker
  const evidence = []
  try {
    key = await request('/api/user/api-key/create', 'POST', { name: 'DSH acceptance temporary' })
    const grant = ids => request('/api/user/api-key/update', 'POST', { accessKey: key.accessKey, name: key.name, status: 1, expire: null, apiConfigs: [], modelIds: ids })
    const openai = models.find(value => value.api === 'openai-completions');
    const anthropicModel = models.find(value => value.api === 'anthropic-messages');
    await grant([Number(openai.id)]);
    const deniedResponse = await fetchModel(tenant.baseModelApiUrl+'/'+anthropicModel.id+'/v1/messages',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key.accessKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:anthropicModel.model,max_tokens:8,messages:[{role:'user',content:'Reply OK'}]}),signal:AbortSignal.timeout(30000)});
    const denial=await deniedResponse.text();evidence.push({operation:'fresh-key-model-permission',status:deniedResponse.status,refused:deniedResponse.status>=400||/permission|denied|权限|无权|403/.test(denial)});
    await grant(models.map(value => Number(value.id)))
    const record = (await request('/api/user/api-key/list')).find(value => value.id === key.id)
    assert.deepEqual(record.config.modelIds.map(String).sort(), models.map(value => value.id).sort())
    broker = createModelBroker({ models, baseUrl: tenant.baseModelApiUrl, apiKey: key.accessKey, current: () => true, port: 0 })
    const base = await broker.start()
    const headers = { Authorization: 'Bearer ' + broker.token, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }
    const post = (id, path, body) => fetchModel(base + '/model/' + id + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) })
    const model = models.find(value => value.api === 'openai-completions')
    const input = { model: model.model, messages: [{ role: 'user', content: 'Call integration_echo with value "DSH_OK", then report the result.' }], tools: [{ type: 'function', function: { name: 'integration_echo', description: 'Echo an integration marker.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }], tool_choice: { type: 'function', function: { name: 'integration_echo' } }, max_tokens: 128, stream: true, stream_options: { include_usage: true } }
    const first = await post(model.id, '/v1/chat/completions', input)
    const text = await first.text()
    const chunks = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => { try { return JSON.parse(line.slice(6)) } catch { return {} } })
    const calls = chunks.flatMap(value => value.choices?.[0]?.delta?.tool_calls ?? [])
    const name = calls.map(value => value.function?.name ?? '').join('')
    const args = calls.map(value => value.function?.arguments ?? '').join('')
    evidence.push({ protocol: 'OpenAI', status: first.status, sse: text.startsWith('data:'), tool: name === 'integration_echo', usage: chunks.find(value => value.usage)?.usage, ...(name === 'integration_echo' ? {} : { refusal: text.replaceAll(key.accessKey, '[redacted]').slice(0, 500) }) })
    if (first.status === 200 && name === 'integration_echo') {
    const id = calls.find(value => value.id)?.id
    input.messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] }, { role: 'tool', tool_call_id: id, content: 'DSH_OK' })
    delete input.tool_choice
    const second = await post(model.id, '/v1/chat/completions', input)
    evidence.push({ operation: 'tool-continuation', status: second.status, result: (await second.text()).includes('DSH_OK') })
    }
    const anthropic = models.find(value => value.api === 'anthropic-messages')
    const anthBody = { model: anthropic.model, messages: [{ role: 'user', content: 'Call integration_echo with value DSH_OK.' }], tools: [{ name: 'integration_echo', description: 'Echo marker', input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }], tool_choice: { type: 'tool', name: 'integration_echo' }, max_tokens: 128, stream: true }
    const third = await post(anthropic.id, '/v1/messages', anthBody)
    const anthText = await third.text()
    evidence.push({ protocol: 'Anthropic', status: third.status, sse: anthText.includes('event:'), tool: anthText.includes('tool_use') && anthText.includes('integration_echo'), ...(anthText.includes('tool_use') ? {} : {refusal:anthText.replaceAll(key.accessKey,'[redacted]').slice(0,500)}) })
    if (third.status === 200 && anthText.includes('tool_use')) {
      const events=anthText.split('\n').filter(line=>line.startsWith('data: ')).map(line=>{try{return JSON.parse(line.slice(6))}catch{return {}}});
      const block=events.find(value=>value.type==='content_block_start'&&value.content_block?.type==='tool_use');
      const partial=events.filter(value=>value.type==='content_block_delta'&&value.index===block?.index).map(value=>value.delta?.partial_json??'').join('');
      const call={...block.content_block,input:partial?JSON.parse(partial):block.content_block.input};
      anthBody.messages.push({role:'assistant',content:[call]},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'DSH_OK'}]});delete anthBody.tool_choice;
      const next=await post(anthropic.id,'/v1/messages',anthBody);
      evidence.push({operation:'anthropic-tool-continuation',status:next.status,result:(await next.text()).includes('DSH_OK')});
    }
    await grant([Number(model.id)])
    const denied = await post(anthropic.id, '/v1/messages', anthBody)
    const deniedBody = await denied.text()
    evidence.push({ operation: 'platform-permission-change', status: denied.status, refused: denied.status >= 400 || /permission|denied|权限|无权|403/.test(deniedBody) })
    return { passed: evidence.every(value => value.status === 200 && value.operation !== 'fresh-key-model-permission' && value.operation !== 'platform-permission-change' ? value.tool !== false && value.result !== false : value.refused === true), evidence }
  } finally {
    await broker?.close()
    if (key) await request('/api/user/api-key/delete/' + encodeURIComponent(key.accessKey), 'POST')
  }
}
