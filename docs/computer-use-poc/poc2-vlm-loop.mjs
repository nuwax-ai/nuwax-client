// PoC 2: VLM 驱动的 computer-use 循环（OpenAI 兼容协议，通道无关）
// 用法:
//   CUA_VLM_API_KEY=... node poc2-vlm-loop.mjs auto      # 全自动：真模型 API
//   node poc2-vlm-loop.mjs manual                         # 半自动：模型侧经 action-N.json 文件握手注入
// env 旋钮: CUA_VLM_BASE_URL(默认 https://open.bigmodel.cn/api/paas/v4)
//           CUA_VLM_MODEL (默认 glm-4.5v)
//           CUA_VLM_API_KEY (auto 必填)
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CuaDriver, DriverOptions, ActionTarget, ClickPosition, InputDeliveryMode,
} from '@trycua/cua-driver';

const pexec = promisify(exec);
const DIR = new URL('.', import.meta.url).pathname;
const RUN = DIR + 'vlm-run/';
const MODE = process.argv[2] ?? 'manual';
const BASE_URL = process.env.CUA_VLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = process.env.CUA_VLM_MODEL ?? 'glm-4.5v';
const TASK = '在计算器里计算 6×7：按顺序点击数字 6、乘号、数字 7、等号，确认显示屏显示 42 后结束。';
const MAX_ROUNDS = 10;

const json = (v) => JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? val.toString() : val), 2);
const log = (...a) => console.log('[poc2]', new Date().toISOString().slice(11, 19), ...a);

const SYSTEM_PROMPT = `你是一个 computer-use 智能体，控制 macOS 计算器。
每轮你会收到：当前窗口截图 + 可交互元素清单（含 element_index、角色、标签、屏幕坐标）+ 历史动作。
你只能输出一行 JSON（不要 markdown 代码块）：
{"thought":"一句话推理","action":"click","element_index":11}
或 {"thought":"...","action":"click","x":2150,"y":830}（坐标兜底，仅在清单里找不到元素时用）
或 {"thought":"...","action":"done","answer":"42"}（任务完成且已确认）
或 {"thought":"...","action":"fail","reason":"..."}
优先用 element_index 定位（截图辅助确认标签），坐标是最后手段。`;

async function findCalc(driver) {
  const { windows } = await driver.listWindows({});
  const win = windows.find((w) => /calculator|计算器/i.test(w.appName));
  if (!win) throw new Error('Calculator window not found（先 open -a Calculator）');
  return win;
}

async function snapshot(driver, win, round) {
  const shot = `${RUN}round-${round}.png`;
  const state = await driver.getWindowState({
    pid: win.pid,
    windowId: win.windowId,
    includeAccessibilityTree: true,
    includeScreenshot: true,
    screenshotOutFile: shot,
    maxElements: 400,
  });
  const elements = (state.elements ?? [])
    .filter((e) => /AXButton|AXWindow|AXTextField|AXCheckBox|AXRadioButton/i.test(e.role))
    .map((e) => ({
      element_index: String(e.elementIndex),
      role: e.role,
      label: e.label ?? '',
      x: e.frame?.x, y: e.frame?.y, w: e.frame?.w, h: e.frame?.h,
    }));
  return { shot, elements };
}

function buildUserText(round, elements, history) {
  const list = elements
    .map((e) => `[${e.element_index}] ${e.role} "${e.label}" @(${e.x},${e.y} ${e.w}x${e.h})`)
    .join('\n');
  const hist = history.length ? history.map((h, i) => `${i + 1}. ${h}`).join('\n') : '（无，第一轮）';
  return `任务：${TASK}\n\n第 ${round} 轮。历史动作：\n${hist}\n\n可交互元素（坐标为全局屏幕坐标，截图与清单同源）：\n${list}\n\n请输出下一动作 JSON。`;
}

async function askVlmAuto(text, imagePath) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CUA_VLM_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            { type: 'text', text },
          ],
        },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`VLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  const m = content.match(/\{[^{}]*\}/s);
  if (!m) throw new Error(`VLM 回复不是 JSON: ${content.slice(0, 200)}`);
  return { action: JSON.parse(m[0]), raw: content, usage: data.usage };
}

async function askVlmManual(round, text) {
  // 文件握手：prompt 落盘，等外部模型侧写 action-<round>.json
  fs.writeFileSync(`${RUN}prompt-${round}.md`, `# round ${round}\n\n（截图见 round-${round}.png）\n\n${text}`);
  const actionFile = `${RUN}action-${round}.json`;
  log(`manual: 等待 ${actionFile}（prompt-${round}.md 已落盘）`);
  for (let i = 0; i < 360; i++) {
    if (fs.existsSync(actionFile)) {
      await new Promise((r) => setTimeout(r, 300));
      return { action: JSON.parse(fs.readFileSync(actionFile, 'utf8')), raw: '<manual-file>' };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`manual 模式第 ${round} 轮等待 action 文件超时（180s）`);
}

async function main() {
  fs.mkdirSync(RUN, { recursive: true });
  const transcript = fs.createWriteStream(`${RUN}transcript.jsonl`);

  const driver = CuaDriver.create(DriverOptions.create({ claudeCodeCompatibility: false }));
  await pexec('open -a Calculator');
  await new Promise((r) => setTimeout(r, 1200));
  const win = await findCalc(driver);
  log('mode=', MODE, 'model=', MODEL, 'base=', BASE_URL, 'window=', json(win).slice(0, 120));

  const history = [];
  const failCount = new Map();
  let final = null;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { shot, elements } = await snapshot(driver, win, round);
    const text = buildUserText(round, elements, history);
    const { action, raw, usage } =
      MODE === 'auto' ? await askVlmAuto(text, shot) : await askVlmManual(round, text);
    log(`round ${round} model →`, JSON.stringify(action));
    transcript.write(json({ round, action, usage, nElements: elements.length }) + '\n');

    if (action.action === 'done' || action.action === 'fail') {
      final = { round, action, ok: action.action === 'done' };
      break;
    }
    if (action.action === 'click') {
      // element_index 优先 → 解析回 element_token 执行；坐标兜底
      const fresh = await driver.getWindowState({
        pid: win.pid, windowId: win.windowId, includeAccessibilityTree: true, maxElements: 400,
      });
      const el = (fresh.elements ?? []).find((e) => String(e.elementIndex) === String(action.element_index));
      const pos = el
        ? new ClickPosition.Element({ elementToken: el.elementToken })
        : new ClickPosition.Coordinates({ x: action.x, y: action.y });
      const res = await driver.click({
        target: new ActionTarget.Window({ pid: win.pid, windowId: win.windowId }),
        position: pos,
        deliveryMode: InputDeliveryMode.Background,
      });
      const label = el?.label ?? `coord(${action.x},${action.y})`;
      history.push(`click "${label}" → ${res.isError ? `失败(${res.errorCode})` : '已投递'}`);
      log(`round ${round} click "${label}" →`, res.isError ? `ERROR ${res.errorCode}` : 'ok');
      // 防抖动：同标签连续失败 3 次中止
      const key = String(label);
      failCount.set(key, (failCount.get(key) ?? 0) + (res.isError ? 1 : 0));
      if (failCount.get(key) >= 3) { final = { round, action, ok: false, reason: `防抖动：${key} 连续失败` }; break; }
    } else {
      throw new Error(`未支持的动作: ${action.action}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  // 终验：截图留档（display 不在 AX 树，验证只能靠截图）
  await snapshot(driver, win, 'final');
  log('final:', json(final ?? { ok: false, reason: '达到最大轮数' }));
  transcript.end();
  await driver.shutdown();
  driver.uniffiDestroy?.();
  process.exit(final?.ok ? 0 : 1);
}

main().catch((e) => { console.error('[poc2] FAILED:', e?.message ?? e); process.exit(1); });
