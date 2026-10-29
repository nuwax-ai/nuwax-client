#!/usr/bin/env node
/**
 * nuwaxcode 多平台集成：准备 resources/nuwaxcode/{platform}/bin/
 *
 * 两种模式：
 * 1) 本地 dist 复制（设置 NUWAXCODE_DIST_DIR 环境变量，开发调试用）
 *    NUWAXCODE_DIST_DIR=~/workspace/nuwaxcode/packages/opencode/dist npm run prepare:nuwaxcode
 * 2) GitHub Release 下载（默认，CI/正式构建用）
 *    npm run prepare:nuwaxcode
 *
 * 打包时 electron-builder extraResources 将 resources/nuwaxcode 打包到应用内
 * 运行时 getNuwaxcodeBundledBinPath() 解析对应平台二进制
 *
 * 用法：
 *   node scripts/prepare/prepare-nuwaxcode.js              # 当前平台
 *   node scripts/prepare/prepare-nuwaxcode.js --all        # 全平台
 *
 * 环境变量：
 *   NUWAXCODE_DIST_DIR     — nuwaxcode 本地构建产物目录（设置后走本地复制模式）
 *   NUWAXCODE_REPO         — GitHub 仓库（默认 nuwax-ai/nuwaxcode）
 *   GH_TOKEN — CI 中由 workflow 注入 github.token（勿自建 GITHUB_ 前缀 Secret）
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');
const { execSync, execFileSync } = require('child_process');
const { getProjectRoot } = require('../utils/project-paths');

const NUWAXCODE_VERSION = '1.17.11';
const NUWAXCODE_REPO = process.env.NUWAXCODE_REPO || 'nuwax-ai/nuwaxcode';

// 官方稳定版 v1.17.11 Release 资产的 GitHub digest。
// 固定归档哈希，避免 CI 将损坏或过期的同名缓存误打进安装包。
const RELEASE_ARCHIVE_SHA256 = {
  'darwin-arm64': '9df3c3c08973fb8c9f4297cccc8f516892e573c46c7879831d96a7bb8fed7438',
  'darwin-x64': 'e7c58fe220c2b8c45541c4ea46f92c152434ed9a5679dd4d42c7d6adfbfd585d',
  'linux-arm64': '087e6b14aeb20128cd887f4580b2c8cbbdca994bb1e2cc6575cfea24aaa17008',
  'linux-arm64-musl': '7f79fc3d8632a44686c3798ee2083dda1be8f19c0d4d701baf40d0791bbe5558',
  'linux-x64': '84b9ddde59ba473deb321304a6bfd1e9723e2ec04ecac04e1eee5f7ca563f575',
  'linux-x64-musl': '1732f933265383e8ec047cd7d2789003d2168d55738e5d6d1d85b66107943ffe',
  'win32-x64': '54ee92454f655c176070865b6b02d0c0ef28191422e39aa1fe9b99f1b16b7e66',
};

/** CI 通过 GH_TOKEN 传入 github.token，避免未认证 API 触发 403 限流 */
function getGithubToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubApiHeaders() {
  const headers = {
    'User-Agent': 'NuwaClaw-Build',
    Accept: 'application/vnd.github+json',
  };
  const token = getGithubToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

const projectRoot = getProjectRoot();
const resDir = path.join(projectRoot, 'resources', 'nuwaxcode');
const cacheDir = path.join(projectRoot, 'scripts', 'resources', 'nuwaxcode-cache');

// Node platform-arch → dist 文件夹名 / Release asset 名
const PLATFORM_MAP = {
  'darwin-arm64': 'nuwaxcode-darwin-arm64',
  'darwin-x64': 'nuwaxcode-darwin-x64',
  'linux-arm64': 'nuwaxcode-linux-arm64',
  'linux-arm64-musl': 'nuwaxcode-linux-arm64-musl',
  'linux-x64': 'nuwaxcode-linux-x64',
  'linux-x64-musl': 'nuwaxcode-linux-x64-musl',
  'win32-x64': 'nuwaxcode-windows-x64',
};

// 资源目录名需与运行时 getNuwaxcodeBundledBinPath() 一致
const RESOURCE_PLATFORM_KEY_MAP = {
  'win32-x64': 'windows-x64',
};

function getPlatformKey() {
  const a = process.env.TARGET_ARCH || process.arch;
  return `${process.platform}-${a}`;
}

function canRunTargetBinary(key) {
  return key === `${process.platform}-${process.arch}`;
}

function getResourcePlatformKey(key) {
  return RESOURCE_PLATFORM_KEY_MAP[key] || key;
}

function isWindows(key) {
  return key.startsWith('win32');
}

function getBinaryName(key) {
  return isWindows(key) ? 'nuwaxcode.exe' : 'nuwaxcode';
}

/**
 * 兼容 release 二进制命名差异：
 * - 历史格式: nuwaxcode / nuwaxcode.exe
 * - 新格式:   opencode  / opencode.exe
 *
 * 说明：
 * 1) 运行时入口仍统一为 resources/.../bin/nuwaxcode(.exe)
 * 2) 这里仅放宽“解压后查找源二进制”的候选名，不改变运行时对外约定
 */
function getBinaryCandidates(key) {
  const preferred = getBinaryName(key);
  const fallback = isWindows(key) ? 'opencode.exe' : 'opencode';
  return [preferred, fallback];
}

/**
 * 清理目标 bin 目录，避免旧版本资源文件残留。
 *
 * 背景：
 * - 历史上这里是“增量覆盖复制”，当新包删除了某些文件（例如 assets/models.json）
 *   而旧包中仍存在时，旧文件会继续留在目标目录，造成“看似升级成功但实际混入旧资源”。
 *
 * 规则：
 * - 每次准备二进制前先删后建，保证目标目录仅包含当前包内容。
 * - 使用 force:true，确保目录不存在时也不会抛错。
 */
function resetDestBinDir(destDir) {
  try {
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      console.warn(
        `[prepare-nuwaxcode] cannot remove ${destDir} (${err.code}); overwriting in place`,
      );
      fs.mkdirSync(destDir, { recursive: true });
      return;
    }
    throw err;
  }
}

/**
 * 确保目标目录存在 assets/model.json。
 *
 * 背景：
 * - 新版 release 有时只包含单二进制，不再附带 assets/model.json。
 * - 业务侧仍有路径会读取该文件，因此这里统一兜底创建最小占位文件。
 *
 * 约束：
 * - 若上游已提供 model.json，则保持原样，不覆盖。
 * - 仅在缺失时创建，内容保持最小且可 JSON.parse。
 */
function ensureModelJson(destDir, version) {
  const assetsDir = path.join(destDir, 'assets');
  const modelJsonPath = path.join(assetsDir, 'model.json');
  if (fs.existsSync(modelJsonPath)) return;

  fs.mkdirSync(assetsDir, { recursive: true });
  const fallback = {
    models: [],
    source: 'generated-fallback',
    version,
  };
  fs.writeFileSync(modelJsonPath, `${JSON.stringify(fallback, null, 2)}\n`, 'utf-8');
}

/**
 * 命中版本与 SHA 时是否仍执行”目录重铺”。
 *
 * 设为 false：版本 + SHA256 + 二进制内部版本号三重校验已足够保证正确性，
 * 无需每次强制解压/复制，显著提升开发调试时的二次构建速度。
 *
 * 若需强制刷新（如清理残留文件），手动删除 resources/nuwaxcode/ 后重新运行。
 */
const FORCE_REFRESH_ON_MATCH = false;

function formatGithubRateLimitReset(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

// ==================== 模式 1: 本地 dist 复制 ====================

function findDistSourceBinary(nuwaxcodeDist, distName, key) {
  const srcBinDir = path.join(nuwaxcodeDist, distName, 'bin');
  for (const name of getBinaryCandidates(key)) {
    const candidate = path.join(srcBinDir, name);
    if (fs.existsSync(candidate)) {
      return { srcBinDir, sourceBinaryName: name };
    }
  }
  return null;
}

function copyFromDist(key) {
  const nuwaxcodeDist = process.env.NUWAXCODE_DIST_DIR || path.join(
    process.env.HOME || '/root',
    'workspace/nuwaxcode/packages/opencode/dist',
  );
  const distName = PLATFORM_MAP[key];
  if (!distName) {
    console.error(`[prepare-nuwaxcode] 不支持的平台: ${key}`);
    return false;
  }

  const resourceKey = getResourcePlatformKey(key);
  const binary = getBinaryName(key);
  const destDir = path.join(resDir, resourceKey, 'bin');
  const destPath = path.join(destDir, binary);
  // 本地 dist 并非固定的官方 Release 资产，不能沿用之前的归档来源标记。
  fs.rmSync(path.join(resDir, `.archive-sha256-${resourceKey}`), { force: true });

  const source = findDistSourceBinary(nuwaxcodeDist, distName, key);
  if (!source) {
    const tried = getBinaryCandidates(key)
      .map((name) => path.join(nuwaxcodeDist, distName, 'bin', name))
      .join(', ');
    console.warn(`[prepare-nuwaxcode] ${key}: 构建产物不存在 (tried: ${tried})`);
    return false;
  }
  const srcPath = path.join(source.srcBinDir, source.sourceBinaryName);

  // 检查是否已是最新（SHA256 一致 + 版本匹配）
  // 注意：codesign 会修改二进制，所以用保存的 .sha256 记录比对 dest（签名后），
  // 而非比对 src（未签名）vs dest（已签名）
  if (fs.existsSync(destPath)) {
    const versionFile = path.join(resDir, '.version');
    if (fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf-8').trim() === NUWAXCODE_VERSION) {
      const shaFile = path.join(resDir, `.sha256-${resourceKey}`);
      if (fs.existsSync(shaFile)) {
        const expectedHash = fs.readFileSync(shaFile, 'utf-8').trim();
        const currentHash = sha256File(destPath);
        if (currentHash === expectedHash) {
          // 额外校验：二进制内部版本号可能与 .version 不一致（曾发生过标记更新但二进制未更新）
          const innerVersion = verifyBinaryVersion(destPath, NUWAXCODE_VERSION, key, currentHash);
          if (innerVersion !== NUWAXCODE_VERSION &&
              (innerVersion !== null || canRunTargetBinary(key))) {
            console.warn(
              `[prepare-nuwaxcode] ${key}: 版本无法确认或不匹配 (${innerVersion})，将重新复制覆盖`,
            );
          } else {
            console.log(
              `[prepare-nuwaxcode] ${key} ✓ (已是最新, SHA256=${currentHash.slice(0, 16)}...)`
              + (FORCE_REFRESH_ON_MATCH ? '，将执行目录重铺以清理残留文件' : ''),
            );
            if (!FORCE_REFRESH_ON_MATCH) return true;
          }
        }
        console.warn(`[prepare-nuwaxcode] ${key}: SHA256 不匹配，需重新复制 (saved=${expectedHash.slice(0, 16)}... current=${currentHash.slice(0, 16)}...)`);
      }
    }
  }

  // 复制前先清理目标目录，确保不会夹带旧版本 assets 残留文件。
  resetDestBinDir(destDir);

  // 复制整个 bin 目录（包含二进制 + assets 等）
  fs.cpSync(source.srcBinDir, destDir, { recursive: true });
  if (source.sourceBinaryName !== binary) {
    const copiedSource = path.join(destDir, source.sourceBinaryName);
    if (fs.existsSync(copiedSource)) {
      const destTmp = `${destPath}.new`;
      fs.copyFileSync(copiedSource, destTmp);
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        fs.renameSync(destTmp, destPath);
      } catch (err) {
        if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
          console.warn(
            `[prepare-nuwaxcode] ${key}: cannot replace locked ${binary} (${err.code}); left ${path.basename(destTmp)} — stop nuwaclaw/electron and re-run prepare`,
          );
          if (fs.existsSync(destTmp)) {
            // Still usable if runtime resolves opencode.exe fallback
          }
        } else {
          throw err;
        }
      }
      if (fs.existsSync(copiedSource) && copiedSource !== destPath) {
        try {
          fs.unlinkSync(copiedSource);
        } catch {
          // ignore
        }
      }
    }
  }
  ensureModelJson(destDir, NUWAXCODE_VERSION);
  fs.chmodSync(destPath, 0o755);

  const sizeMB = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
  console.log(`[prepare-nuwaxcode] ${key} ✓ 从本地 dist 复制 (${sizeMB} MB)`);

  // macOS ad-hoc 签名
  codesign(destPath, key);

  // 计算 SHA256（签名后），用于打印 + 保存
  const hash = sha256File(destPath);

  // 验证二进制内部版本号 + 打印 SHA256
  const copiedVersion = verifyBinaryVersion(destPath, NUWAXCODE_VERSION, key, hash);
  if (copiedVersion !== NUWAXCODE_VERSION &&
      (copiedVersion !== null || canRunTargetBinary(key))) {
    throw new Error(`本地 dist 二进制版本不符: ${copiedVersion} (expected ${NUWAXCODE_VERSION})`);
  }

  // 保存 SHA256 记录，下次可精确跳过
  fs.writeFileSync(path.join(resDir, `.sha256-${resourceKey}`), hash, 'utf-8');

  return true;
}

// ==================== 模式 2: GitHub Release 下载 ====================

/**
 * 当前平台资源是否已就绪（Actions 缓存恢复后无需再调 GitHub API）。
 */
function isPlatformResourceReady(key) {
  const resourceKey = getResourcePlatformKey(key);
  const destPath = path.join(resDir, resourceKey, 'bin', getBinaryName(key));
  const versionFile = path.join(resDir, '.version');
  const shaFile = path.join(resDir, `.sha256-${resourceKey}`);
  const sourceShaFile = path.join(resDir, `.archive-sha256-${resourceKey}`);
  if (!fs.existsSync(destPath) || !fs.existsSync(versionFile) || !fs.existsSync(shaFile) || !fs.existsSync(sourceShaFile)) {
    return false;
  }
  if (fs.readFileSync(versionFile, 'utf-8').trim() !== NUWAXCODE_VERSION) {
    return false;
  }
  if (fs.readFileSync(sourceShaFile, 'utf-8').trim() !== RELEASE_ARCHIVE_SHA256[key]) {
    return false;
  }
  const expectedHash = fs.readFileSync(shaFile, 'utf-8').trim();
  return sha256File(destPath) === expectedHash;
}

function shouldRetryGithubStatus(statusCode) {
  return statusCode === 403 || statusCode === 429 || statusCode === 502 || statusCode === 503;
}

/**
 * 检查 GitHub 是否存在目标 Release tag（避免目标版本未发版时反复 404）。
 * 403/429 时指数退避重试；已缓存资源时由 main() 跳过本检查。
 * @returns {Promise<{ ok: boolean, latestTag?: string, status?: number, unverified?: boolean, reason?: string }>}
 */
function checkGithubReleaseTag() {
  return new Promise((resolve) => {
    const tag = `v${NUWAXCODE_VERSION}`;
    const apiUrl = `https://api.github.com/repos/${NUWAXCODE_REPO}/releases/tags/${tag}`;
    const headers = githubApiHeaders();

    if (!getGithubToken()) {
      console.warn(
        '[prepare-nuwaxcode] 未设置 GH_TOKEN，GitHub API 可能因限流返回 403',
      );
    }

    let attempts = 0;
    const maxAttempts = 6;

    const tryRequest = async () => {
      attempts++;
      console.log(`[prepare-nuwaxcode] 检查 Release ${tag} (尝试 ${attempts}/${maxAttempts})...`);

      const response = await new Promise((resolveResponse, reject) => {
        https
          .get(apiUrl, { headers }, (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => {
              resolveResponse({
                statusCode: res.statusCode || 0,
                body,
                headers: res.headers,
              });
            });
          })
          .on('error', reject);
      }).catch((err) => {
        console.warn(
          `[prepare-nuwaxcode] 网络错误 (尝试 ${attempts}/${maxAttempts}): ${err.message}`,
        );
        return { statusCode: -1, body: '', headers: {} };
      });
      const statusCode = response.statusCode;

      if (statusCode === 200) {
        console.log(`[prepare-nuwaxcode] ✓ Release ${tag} 存在`);
        resolve({ ok: true });
        return;
      }

      const retryable = statusCode === -1 || shouldRetryGithubStatus(statusCode);
      const hint =
        statusCode === 403 || statusCode === 429
          ? '（多为 API 限流，请在 CI 配置 GH_TOKEN=github.token 或稍后重试）'
          : '';
      console.warn(
        `[prepare-nuwaxcode] Release ${tag} 检查失败: HTTP ${statusCode}${hint}`,
      );

      if (retryable && attempts < maxAttempts) {
        const delayMs = Math.min(1000 * 2 ** (attempts - 1), 30000);
        console.log(`[prepare-nuwaxcode] ${delayMs}ms 后重试...`);
        await sleep(delayMs);
        return tryRequest();
      }

      let message = '';
      try {
        message = JSON.parse(response.body).message || '';
      } catch (_) {}
      const rateLimitRemaining = response.headers['x-ratelimit-remaining'];
      const rateLimitReset = formatGithubRateLimitReset(response.headers['x-ratelimit-reset']);
      const isRateLimited =
        statusCode === 403 &&
        (rateLimitRemaining === '0' || /rate limit/i.test(message));

      if (isRateLimited) {
        console.warn(
          `[prepare-nuwaxcode] GitHub API 匿名限流，跳过 Release 预检查并直接尝试下载资产`
          + (rateLimitReset ? `（重置时间: ${rateLimitReset}）` : ''),
        );
        resolve({
          ok: true,
          status: statusCode,
          unverified: true,
          reason: 'github_api_rate_limited',
        });
        return;
      }

      const latestUrl = `https://api.github.com/repos/${NUWAXCODE_REPO}/releases/latest`;
      https
        .get(latestUrl, { headers }, (res2) => {
          let body2 = '';
          res2.on('data', (c) => {
            body2 += c;
          });
          res2.on('end', () => {
            let latestTag;
            try {
              latestTag = JSON.parse(body2).tag_name;
            } catch (_) {}
            resolve({ ok: false, latestTag, status: statusCode, reason: message });
          });
        })
        .on('error', () => resolve({ ok: false, status: statusCode }));
    };

    tryRequest();
  });
}

/**
 * 下载文件到缓存目录
 * @param {{ force?: boolean }} [options] force=true 时忽略已有缓存（解压失败/缓存截断时用）
 */
function download(url, preferredFilename, options = {}) {
  const force = !!options.force;
  return new Promise((resolve, reject) => {
    const filename = preferredFilename || path.basename(url.split('?')[0]) || 'download';
    const file = path.join(cacheDir, filename);

    // 缓存检查（仅看大小，不校验 gzip；损坏时需 force 重下）
    if (!force && fs.existsSync(file)) {
      try {
        const stats = fs.statSync(file);
        if (stats.size > 100 * 1024) {
          console.log(`[prepare-nuwaxcode] 使用缓存: ${filename} (${Math.round(stats.size / 1024 / 1024)} MB)`);
          resolve(file);
          return;
        }
      } catch (_) {}
      try { fs.unlinkSync(file); } catch (_) {}
    }

    if (force && fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch (_) {}
    }

    const headers = githubApiHeaders();

    fs.mkdirSync(cacheDir, { recursive: true });
    const doRequest = (reqUrl, redirects) => {
      if (redirects > 10) return reject(new Error('Too many redirects'));
      https.get(reqUrl, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const loc = res.headers.location;
          const nextUrl = loc.startsWith('http') ? loc : new URL(loc, reqUrl).href;
          doRequest(nextUrl, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          try { fs.unlinkSync(file); } catch (_) {}
          return reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`));
        }
        const stream = fs.createWriteStream(file);
        res.pipe(stream);
        stream.on('finish', () => { stream.close(); resolve(file); });
        stream.on('error', (e) => {
          stream.close();
          try { fs.unlinkSync(file); } catch (_) {}
          reject(e);
        });
      }).on('error', reject);
    };
    doRequest(url, 0);
  });
}

/**
 * 从 GitHub Release 下载并解压
 */
async function downloadFromRelease(key) {
  const distName = PLATFORM_MAP[key];
  if (!distName) {
    console.error(`[prepare-nuwaxcode] 不支持的平台: ${key}`);
    return false;
  }

  const resourceKey = getResourcePlatformKey(key);
  const binary = getBinaryName(key);
  const destDir = path.join(resDir, resourceKey, 'bin');
  const destPath = path.join(destDir, binary);
  const expectedArchiveHash = RELEASE_ARCHIVE_SHA256[key];
  if (!expectedArchiveHash) {
    console.error(`[prepare-nuwaxcode] ${key}: 缺少官方 Release 资产 SHA256`);
    return false;
  }

  // 检查是否已是最新（版本匹配 + SHA256 一致）
  const versionFile = path.join(resDir, '.version');
  const sourceShaFile = path.join(resDir, `.archive-sha256-${resourceKey}`);
  const shaFile = path.join(resDir, `.sha256-${resourceKey}`);
  if (fs.existsSync(destPath) && fs.existsSync(versionFile) &&
      fs.existsSync(shaFile) && fs.existsSync(sourceShaFile) &&
      fs.readFileSync(versionFile, 'utf-8').trim() === NUWAXCODE_VERSION &&
      fs.readFileSync(sourceShaFile, 'utf-8').trim() === expectedArchiveHash) {
    const expectedHash = fs.readFileSync(shaFile, 'utf-8').trim();
    const currentHash = sha256File(destPath);
    if (currentHash === expectedHash) {
      const innerVersion = verifyBinaryVersion(destPath, NUWAXCODE_VERSION, key, currentHash);
      if (innerVersion !== NUWAXCODE_VERSION &&
          (innerVersion !== null || canRunTargetBinary(key))) {
        console.warn(
          `[prepare-nuwaxcode] ${key}: 缓存二进制版本无法确认或不匹配 (${innerVersion})，将重新下载`,
        );
      } else {
        const sizeMB = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
        console.log(
          `[prepare-nuwaxcode] ${key} ✓ (已是最新 ${sizeMB} MB, SHA256=${currentHash.slice(0, 16)}...)`
          + (FORCE_REFRESH_ON_MATCH ? '，将执行目录重铺以清理残留文件' : ''),
        );
        if (!FORCE_REFRESH_ON_MATCH) return true;
      }
    } else {
      console.warn(`[prepare-nuwaxcode] ${key}: SHA256 不匹配，需重新下载 (expected=${expectedHash.slice(0, 16)}... current=${currentHash.slice(0, 16)}...)`);
    }
  }

  // 此稳定版每个平台资产均有版本后缀，且必须命中对应的固定 SHA256。
  const assetCandidates = [`${distName}-v${NUWAXCODE_VERSION}.tar.gz`];

  // Windows：PATH 里常见的是 System32 的 bsdtar，它不认 MSYS 的 /d/a/... 路径，
  // 只认盘符路径（D:\... 或 D:/...）。Git for Windows 的 GNU tar 也接受 D:/...。
  const toTarPath = (p) => {
    if (process.platform !== 'win32') return p;
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (!match) return p.replace(/\\/g, '/');
    const drive = match[1];
    const rest = match[2].replace(/\\/g, '/');
    return `${drive}:/${rest}`;
  };

  let lastErr = null;
  for (const assetName of assetCandidates) {
    const downloadUrl = `https://github.com/${NUWAXCODE_REPO}/releases/download/v${NUWAXCODE_VERSION}/${assetName}`;
    console.log(`[prepare-nuwaxcode] ${key}: 尝试下载 ${assetName} ...`);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const force = attempt > 0;
        if (force) {
          console.warn(
            `[prepare-nuwaxcode] ${key}: 缓存校验或解压失败，将删除缓存并重新下载 ${assetName}`,
          );
        }

        const archivePath = await download(downloadUrl, assetName, { force });
        const archiveHash = sha256File(archivePath);
        if (archiveHash !== expectedArchiveHash) {
          console.warn(`[prepare-nuwaxcode] ${key}: 归档 SHA256 不匹配 (${archiveHash})`);
          if (attempt === 0) continue;
          throw new Error(`归档 SHA256 不匹配: ${assetName}`);
        }

        // 解压到临时目录
        const extractDir = path.join(cacheDir, `extract-${key}`);
        if (fs.existsSync(extractDir)) {
          try { fs.rmSync(extractDir, { recursive: true }); } catch (_) {}
        }
        fs.mkdirSync(extractDir, { recursive: true });

        const tarArchivePath = toTarPath(archivePath);
        const tarExtractDir = toTarPath(extractDir);

        // 使用参数数组调用 tar，避免在 Windows/MSYS 下对 C:\ 路径的错误解析。
        // --force-local 仅在 win32 且 tar 支持时使用（macOS BSD tar 不支持该选项）。
        const tarArgs = ['-xzf', tarArchivePath, '-C', tarExtractDir];
        if (process.platform === 'win32') {
          try {
            const tarHelp = execFileSync('tar', ['--help'], { encoding: 'utf-8', stdio: 'pipe' });
            if (typeof tarHelp === 'string' && tarHelp.includes('--force-local')) {
              tarArgs.unshift('--force-local');
            }
          } catch (_) {}
        }

        try {
          execFileSync('tar', tarArgs, { stdio: 'pipe' });
        } catch (tarErr) {
          if (attempt === 1) throw tarErr;
          continue;
        }

        // 查找二进制文件：优先新名称 nuwaxcode，其次兼容旧名称 opencode。
        // 背景：部分历史 release 资产仍产出 opencode 可执行文件。
        const binaryCandidates = getBinaryCandidates(key);
        const binaryPath = findBinary(extractDir, binaryCandidates);
        if (!binaryPath) {
          if (attempt === 1) {
            throw new Error(`解压后未找到可执行文件（候选: ${binaryCandidates.join(', ')}）`);
          }
          continue;
        }

        // 复制前先清理目标目录，避免旧版本 assets 文件被“增量复制”保留下来。
        resetDestBinDir(destDir);

        const extractedBinDir = path.dirname(binaryPath);
        const extractedBaseName = path.basename(binaryPath);

        // 复制策略：
        // A. 命中标准名（nuwaxcode）时，复制整个 bin 目录，尽量保留同目录 assets
        // B. 命中别名（opencode）时，按目标标准名落盘，保证后续路径稳定
        if (extractedBaseName === binary) {
          fs.cpSync(extractedBinDir, destDir, { recursive: true });
        } else {
          fs.copyFileSync(binaryPath, destPath);
          // 复制同目录 assets（如 models.json）
          const assetsDir = path.join(extractedBinDir, 'assets');
          if (fs.existsSync(assetsDir)) {
            const destAssetsDir = path.join(destDir, 'assets');
            fs.mkdirSync(destAssetsDir, { recursive: true });
            fs.cpSync(assetsDir, destAssetsDir, { recursive: true });
          }
        }
        ensureModelJson(destDir, NUWAXCODE_VERSION);
        fs.chmodSync(destPath, 0o755);

        const sizeMB = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
        console.log(`[prepare-nuwaxcode] ${key} ✓ 从 GitHub Release 下载 (${sizeMB} MB)`);

        // macOS ad-hoc 签名
        codesign(destPath, key);

        // 计算 SHA256（签名后），用于打印 + 保存
        const hash = sha256File(destPath);

        // 验证二进制内部版本号 + 打印 SHA256
        const innerVersion = verifyBinaryVersion(destPath, NUWAXCODE_VERSION, key, hash);
        if (innerVersion !== NUWAXCODE_VERSION &&
            (innerVersion !== null || canRunTargetBinary(key))) {
          // 常见于：本地缓存的 tar.gz 仍是旧内容（例如同名资产被替换、或缓存命中导致一直用旧包）
          // 第一次发现不一致时，删除缓存并强制重新下载再试一次。
          if (attempt === 0) {
            console.warn(
              `[prepare-nuwaxcode] ${key}: 检测到二进制版本不一致，将删除缓存并强制重新下载 ${assetName} 再验证一次`,
            );
            continue;
          }
          throw new Error(`二进制版本无法确认或不符: ${innerVersion} (expected ${NUWAXCODE_VERSION})`);
        }

        // 保存 SHA256 记录，下次可精确跳过
        fs.writeFileSync(path.join(resDir, `.sha256-${resourceKey}`), hash, 'utf-8');
        fs.writeFileSync(sourceShaFile, expectedArchiveHash, 'utf-8');

        return true;
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[prepare-nuwaxcode] ${key}: 官方资产 ${assetName} 失败 (${err.message})`);
    }
  }

  console.error(`[prepare-nuwaxcode] ${key}: 下载失败: ${lastErr ? lastErr.message : 'unknown error'}`);
  console.error(`[prepare-nuwaxcode] 请确认 GitHub Release 存在: https://github.com/${NUWAXCODE_REPO}/releases/tag/v${NUWAXCODE_VERSION}`);
  return false;
}

/**
 * 在解压目录中递归查找二进制文件
 */
function findBinary(dir, binaryNames) {
  const names = Array.isArray(binaryNames) ? binaryNames : [binaryNames];

  // 先走最常见目录：bin/ 与 package/bin/
  for (const name of names) {
    const direct = path.join(dir, 'bin', name);
    if (fs.existsSync(direct)) return direct;

    const pkgBin = path.join(dir, 'package', 'bin', name);
    if (fs.existsSync(pkgBin)) return pkgBin;
  }

  // 新 release 可能是“根目录单文件”
  for (const name of names) {
    const rootFile = path.join(dir, name);
    if (fs.existsSync(rootFile)) return rootFile;
  }

  // 最后兜底递归搜索（最多 3 层）
  for (const name of names) {
    const found = _findRecursive(dir, name, 3);
    if (found) return found;
  }
  return null;
}

function _findRecursive(dir, binaryName, maxDepth) {
  if (maxDepth <= 0) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === binaryName) return fullPath;
      if (entry.isDirectory()) {
        const found = _findRecursive(fullPath, binaryName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch (_) {}
  return null;
}

// ==================== 通用 ====================

/**
 * 计算文件 SHA256
 */
function sha256File(filePath) {
  try {
    return execFileSync('shasum', ['-a', '256', filePath], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split(/\s+/)[0];
  } catch {
    // Windows 或无 shasum 时，用 Node.js crypto
    const crypto = require('crypto');
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}

/**
 * 验证二进制内部版本号是否与期望版本匹配
 * nuwaxcode 的 release tag 可能与二进制内部版本不一致，
 * 需要检测以避免 .version 标记与实际二进制不符。
 */
function verifyBinaryVersion(binaryPath, expectedVersion, key, hash) {
  // 打印 SHA256（由调用方传入，避免重复计算）
  if (hash) {
    console.log(`[prepare-nuwaxcode] ${key}: SHA256=${hash}`);
  }

  try {
    const output = execFileSync(binaryPath, ['-v'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (output !== expectedVersion) {
      console.warn(
        `[prepare-nuwaxcode] ${key}: ⚠️ 二进制内部版本 ${output} 与期望版本 ${expectedVersion} 不一致（release tag 版本与二进制版本不同步）`,
      );
    }
    return output;
  } catch (e) {
    // 二进制可能不支持 -v 或无法在本平台执行（交叉编译场景），跳过校验
    console.warn(`[prepare-nuwaxcode] ${key}: 无法验证二进制版本（${e.message}），跳过校验`);
    return null;
  }
}

function codesign(binaryPath, key) {
  if (process.platform === 'darwin') {
    try {
      execSync(`codesign --force --sign - "${binaryPath}"`, { stdio: 'pipe' });
    } catch {
      console.warn(`[prepare-nuwaxcode] ${key} 签名失败（不影响功能）`);
    }
  }
}

async function main() {
  const allPlatforms = process.argv.includes('--all') || process.argv.includes('--all-platforms');
  const useLocalDist = !!process.env.NUWAXCODE_DIST_DIR;
  const mode = useLocalDist ? '本地 dist 复制' : 'GitHub Release 下载';

  fs.mkdirSync(resDir, { recursive: true });

  const keys = allPlatforms ? Object.keys(PLATFORM_MAP) : [getPlatformKey()];

  console.log(`[prepare-nuwaxcode] 模式: ${mode}`);
  console.log(`[prepare-nuwaxcode] 版本: v${NUWAXCODE_VERSION}`);
  console.log(`[prepare-nuwaxcode] 平台: ${keys.join(', ')}`);

  if (!useLocalDist) {
    const allKeysReady = keys.every((key) => PLATFORM_MAP[key] && isPlatformResourceReady(key));
    if (allKeysReady) {
      console.log(
        `[prepare-nuwaxcode] 已缓存 v${NUWAXCODE_VERSION} 资源 (${keys.join(', ')})，跳过 GitHub Release API 检查`,
      );
    } else {
      const releaseCheck = await checkGithubReleaseTag();
      if (!releaseCheck.ok) {
        console.error(
          `[prepare-nuwaxcode] 无法确认 GitHub Release: https://github.com/${NUWAXCODE_REPO}/releases/tag/v${NUWAXCODE_VERSION}`,
        );
        if (releaseCheck.status) {
          console.error(
            `[prepare-nuwaxcode] GitHub API 状态: HTTP ${releaseCheck.status}${releaseCheck.reason ? ` (${releaseCheck.reason})` : ''}`,
          );
        }
        if (releaseCheck.latestTag) {
          console.error(
            `[prepare-nuwaxcode] 当前远端最新 Release: ${releaseCheck.latestTag}（与 prepare 脚本 NUWAXCODE_VERSION=${NUWAXCODE_VERSION} 不一致）`,
          );
        }
        console.error('[prepare-nuwaxcode] 可选方案:');
        console.error(
          `  1) 在 nuwaxcode 仓库执行 ./release.sh ${NUWAXCODE_VERSION} 发布 GitHub Release`,
        );
        console.error(
          '  2) 开发调试: NUWAXCODE_DIST_DIR=<nuwaxcode>/packages/opencode/dist npm run prepare:nuwaxcode',
        );
        console.error(
          '  3) 临时回退: 修改 prepare-nuwaxcode.js 中 NUWAXCODE_VERSION 为已存在的 tag（不推荐用于发版）',
        );
        process.exit(1);
      }
      if (releaseCheck.unverified) {
        console.log(
          `[prepare-nuwaxcode] GitHub Release v${NUWAXCODE_VERSION} 预检查被跳过，将以资产下载结果为准`,
        );
      } else {
        console.log(
          `[prepare-nuwaxcode] GitHub Release v${NUWAXCODE_VERSION} 已存在`,
        );
      }
    }
  }

  if (!allPlatforms && !PLATFORM_MAP[keys[0]]) {
    console.error(`[prepare-nuwaxcode] 不支持的平台: ${keys[0]}`);
    console.error(`[prepare-nuwaxcode] 支持的平台: ${Object.keys(PLATFORM_MAP).join(', ')}`);
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;

  for (const key of keys) {
    const success = useLocalDist ? copyFromDist(key) : await downloadFromRelease(key);
    if (success) {
      ok++;
    } else {
      fail++;
    }
  }

  if (ok > 0) {
    // 写入版本标记
    fs.writeFileSync(path.join(resDir, '.version'), NUWAXCODE_VERSION, 'utf-8');
    console.log(`[prepare-nuwaxcode] ✓ 版本: ${NUWAXCODE_VERSION}`);
  }

  console.log(`[prepare-nuwaxcode] 完成: ${ok} 成功, ${fail} 失败`);

  if (fail > 0) {
    process.exit(1);
  }
}

main();
