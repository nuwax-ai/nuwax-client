import { createHash } from 'node:crypto';

export const SUITE_VERSION = 'desktop-v1.1';
export const TASKS = [
  { id: 'F01', kind: 'fixture', category: 'text-input', title: '填写中文表单', goal: '把姓名填写为「林晓」，城市填写为「成都」，点击「提交」。', expected: { name: '林晓', city: '成都', submitted: true } },
  { id: 'F02', kind: 'fixture', category: 'text-replace', title: '修改已有文本', goal: '把备注原有内容完整替换为「会议改到周五下午三点」，点击「保存备注」。', expected: { note: '会议改到周五下午三点', submitted: true } },
  { id: 'F03', kind: 'fixture', category: 'element-choice', title: '选择指定项目', goal: '选择「标准方案」，勾选「包含附件」，点击「确认选择」。', expected: { choice: 'standard', attachment: true, submitted: true } },
  { id: 'F04', kind: 'fixture', category: 'scroll', title: '滚动寻找目标', goal: '滚动列表，找到「条目 28」，点击这一项的「选择条目 28」按钮。', expected: { picked: 28, scrolled: true, visible: true } },
  { id: 'F05', kind: 'fixture', category: 'loading-recovery', title: '等待加载后操作', goal: '点击「加载项目」，等到项目加载完成后点击「确认加载的项目」。', expected: { loaded: true, confirmed: true } },
  { id: 'F06', kind: 'fixture', category: 'dynamic-ui', title: '界面变化后重新定位', goal: '点击「刷新列表」，在刷新后的列表中点击「选择青竹」。', expected: { refreshed: true, picked: '青竹' } },
  { id: 'N01', kind: 'native', category: 'native-text-replace', title: '原生编辑器修改文本', goal: '把这个测试文档的全部正文替换为「Nuwax 原生编辑验收：成都，周五 15:00。」；确认正文正确后结束，无需保存文件。', expected: { text: 'Nuwax 原生编辑验收：成都，周五 15:00。' } },
];

export function selectTasks(ids) {
  if (!ids) return TASKS;
  const selected = ids.split(',');
  if (new Set(selected).size !== selected.length || selected.some(id => !TASKS.some(t => t.id === id))) throw new Error('invalidTaskSelection');
  return selected.map(id => TASKS.find(t => t.id === id));
}

export function checkFixture(task, state) {
  return state.wrong !== true && Object.entries(task.expected).every(([key, value]) => state[key] === value);
}

export function checkNative(task, reply) {
  if (!reply?.ok || reply.result?.isError) return false;
  const elements = reply.result?.structuredContent?.elements;
  if (!Array.isArray(elements)) return false;
  const wanted = task.expected.text.trim();
  return elements.some(e => [e.value, e.label, e.text].some(value => typeof value === 'string' && value.trim() === wanted));
}

export function failureCategory({ reason, oracle, calls = [], blocked = false }) {
  if (blocked) return 'environment';
  if (reason === 'boundaryViolation') return 'control-boundary';
  if (reason && /foreground|background|userTaking|user_in_control/.test(reason)) return 'input-capability';
  if (reason && /targetClosed|target_identity|binding|target_not/.test(reason)) return 'window-lifecycle';
  if (reason && /uncertain/.test(reason)) return 'uncertain-action';
  if (reason && /timeLimit|Timeout|timeout/.test(reason)) return 'timeout';
  if (reason && /model|provider|vision|agent/.test(reason)) return 'model-or-provider';
  if (reason && /noProgress|repetition/.test(reason)) return 'no-progress';
  if (calls.some(c => c.outcome === 'refused')) return 'action-refused';
  return oracle ? null : 'result-mismatch';
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export function summarize(results, expectedRuns) {
  const success = results.filter(r => r.status === 'passed' && r.interventions === 0).length;
  const costsKnown = results.length > 0 && results.every(r => Number.isFinite(r.costUsd));
  const totalCost = costsKnown ? results.reduce((n, r) => n + r.costUsd, 0) : null;
  const failures = {};
  for (const r of results) if (r.status !== 'passed') failures[r.failure ?? 'unknown'] = (failures[r.failure ?? 'unknown'] ?? 0) + 1;
  const attempted = results.filter(r => r.status !== 'blocked');
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const refusalCodes = {};
  for (const r of results) for (const call of r.calls ?? []) if (call.outcome === 'refused') {
    refusalCodes[call.code ?? 'unknown'] = (refusalCodes[call.code ?? 'unknown'] ?? 0) + 1;
  }
  return {
    planned: expectedRuns, recorded: results.length, passedUnassisted: success,
    passedAssisted: results.filter(r => r.status === 'passed' && r.interventions > 0).length,
    blocked: results.filter(r => r.status === 'blocked').length,
    unassistedSuccessRate: expectedRuns > 0 ? success / expectedRuns : null,
    completed: results.length === expectedRuns,
    durationMsMean: mean(attempted.map(r => r.durationMs)),
    durationMsP50: percentile(attempted.map(r => r.durationMs), .5),
    durationMsP95: percentile(attempted.map(r => r.durationMs), .95),
    toolCallsMean: mean(attempted.map(r => r.calls?.length ?? r.stats?.steps ?? 0)),
    totalCostUsd: totalCost, costPerSuccessfulTaskUsd: totalCost !== null && success > 0 ? totalCost / success : null,
    failures, refusalCodes,
  };
}

export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function observationArgs(tool, args, modality) {
  // capture_mode is ignored by current Windows helpers; the explicit screenshot
  // switch is needed for a real AX-only diagnostic rather than mislabeled hybrid.
  return modality === 'ax' && ['get_window_state', 'get_accessibility_tree', 'get_desktop_state'].includes(tool)
    ? { ...args, include_screenshot: false } : args;
}

export function cancellable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('runCancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

export function buildAgentConfig({ model, baseUrl, proxyToken }) {
  if (!proxyToken) throw new Error('modelProxyTokenRequired');
  // Deny builtins in the engine as well as at the ACP client boundary. Wildcards
  // must precede the explicit MCP allow rule (opencode uses last-match wins).
  return {
    model: `cua-bench/${model}`, small_model: `cua-bench/${model}`, autoupdate: false,
    enabled_providers: ['cua-bench'], plugin: [],
    tools: { '*': false, 'cua_*': true }, permission: { '*': 'deny', 'cua_*': 'allow' },
    provider: { 'cua-bench': { npm: '@ai-sdk/openai-compatible', name: 'CUA benchmark',
      options: { baseURL: baseUrl, apiKey: proxyToken },
      models: { [model]: { name: model, attachment: true, tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 200000, output: 8192 } } } } },
  };
}
