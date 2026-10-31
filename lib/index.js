// 删除/写入命令守卫（host 插件，无 client 半）。
//
// 目标：
//   「先拦截 → 你看到 → 你解释 → 我点头 → 再放行」
//   「删根目录和其他系统目录直接拦死，而且告知不得再次尝试删除此类目录，
//     包含通配符也拦死，告知不得使用通配符而是应该定点删除，那些就拦一下」
//
// 为什么要有这层壳：用户开 workspace-write 之类权限后，沙箱弹的提权确认里全是
// $ % # 之类的符号和英文路径，看不懂；怕点太快误操作。所以这层壳的价值不在
// 「技术性拦截」，而在**在提权弹窗出现之前先给一份能看懂的中文说明**：
// 要动什么、有什么用、动坏了会怎样。
//
// 三档处置：
//   1) 通配符           → 永不放行。不管重发几次都拒，并明确要求改成定点操作。
//   2) 盘根 / 系统目录  → 永不放行。并明确说「不得再次尝试」。
//   3) 普通删除 / 写入  → 拦一次；模型解释清楚、用户点头后原样重发，放行一次。
//
// 已知边界，写给自己别自欺：
//   * 这是**减速带**，不是安全边界。换写法的删除绕得过去：
//     `[System.IO.File]::Delete()`、`run_code` 里的 `fs.rmSync`、`robocopy /MIR`、
//     `git clean -fdx`、`Move-Item -Force` 覆盖。
//   * 「第二次放行」分不清「用户点头了」和「模型自己想删」。真正的硬门只有 DSH
//     审批弹窗（ask），但如果 approval policy 设成 never，ask 会被自动拒绝。
//   * `run_code`（PTC）与 `write` / `edit` 工具不在本插件管辖内。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-fileguard';

// tools 服务提供 ctx.tools.guard()；不注入就注册不上守卫。
export const inject = ['tools'];

// 设置命名空间，必须与 cordis.patch.yml 里 entry 的 id 一致。
export const NS = 'dsh-fileguard';

const LOG = process.env.DSH_FILEGUARD_LOG ?? path.join(os.tmpdir(), 'dsh-fileguard.log');

// ---- 策略档位 -----------------------------------------------------------------
// 四档设计。切换走 /guard-* 斜杠命令或设置页，两者都只写这个
// 小文件；check() 每次按键重读（带 1 秒缓存），所以切换即刻生效，不用重启 DSH、
// 也不用改 cordis.patch.yml。config 里的 policy 只当兜底初值。
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POLICY_FILE = process.env.DSH_FILEGUARD_POLICY ?? path.join(PLUGIN_DIR, 'policy.json');

const POLICY_META = [
  {
    key: 'low',
    command: 'guard-low',
    label: '低守卫',
    summary: '只拦根目录和系统目录的删除，普通删除直接放行',
  },
  {
    key: 'default',
    command: 'guard-default',
    label: '默认',
    summary: '删除命令拦一次，要模型说明清楚你点头后再放行',
  },
  {
    key: 'high',
    command: 'guard-high',
    label: '高拦截',
    summary: '删除和修改命令都拦一次；read / write / edit 这些工具不受影响',
  },
  {
    key: 'readonly',
    command: 'guard-readonly',
    label: '纯白名单',
    summary: '只放行只读命令，其余一律拦死',
  },
];
const POLICY_KEYS = POLICY_META.map((p) => p.key);

// policy.json 存两样东西：档位 policy、临时文件窗口 tempHours（小时）。
// 缓存整份文档而不是只缓存档位——两条命令各改一个字段，读的时候要保留另一个。
let policyCache = { at: 0, doc: null };

const TEMP_HOURS_DEFAULT = 8;
const TEMP_HOURS_MAX = 720; // 30 天，再长就不算「临时」了

/** 读 policy.json 全文。坏文件 / 不存在都当空文档，交给 config 兜底。 */
function readPolicyDoc() {
  const now = Date.now();
  if (now - policyCache.at < 1000) return policyCache.doc;
  policyCache.at = now;
  try {
    const raw = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
    policyCache.doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    policyCache.doc = null;
  }
  return policyCache.doc;
}

/** 读命令/设置页写下的档位；没有或认不出来返回 null，交给 config 兜底。 */
function readPolicyFile() {
  const p = String(readPolicyDoc()?.policy ?? '');
  return POLICY_KEYS.includes(p) ? p : null;
}

/** 改 policy.json 里的若干字段，其余字段原样保留。写失败只记日志不抛。 */
function patchPolicyFile(patch) {
  const cur = readPolicyDoc();
  const next = {
    ...(cur && typeof cur === 'object' ? cur : {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
    fs.writeFileSync(POLICY_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
    policyCache = { at: 0, doc: next };
    return true;
  } catch (e) {
    log(`POLICY-WRITE-FAIL ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 写档位。写失败只记日志不抛——命令得能给出人话反馈。 */
function writePolicyFile(policy) {
  const ok = patchPolicyFile({ policy });
  if (ok) log(`POLICY=${policy}`);
  return ok;
}

/** 临时文件免审窗口（小时）。0 = 关掉这个机制。 */
function tempHours(config) {
  const fromFile = readPolicyDoc()?.tempHours;
  if (typeof fromFile === 'number' && Number.isFinite(fromFile) && fromFile >= 0) {
    return Math.min(fromFile, TEMP_HOURS_MAX);
  }
  const fromConfig = config?.tempHours;
  if (typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig >= 0) {
    return Math.min(fromConfig, TEMP_HOURS_MAX);
  }
  return TEMP_HOURS_DEFAULT;
}

/** 当前生效档位：命令/设置页写过就用它，否则 config.policy，再否则 default。 */
function resolvePolicy(config) {
  const fromFile = readPolicyFile();
  if (fromFile) return fromFile;
  const fromConfig = String(config?.policy ?? '');
  return POLICY_KEYS.includes(fromConfig) ? fromConfig : 'default';
}


function log(msg) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* 日志失败不影响拦截 */
  }
}

// 只处理能执行任意命令的工具。名字必须与工具注册名逐字一致。
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'terminal', 'pwsh_persistent', 'bash_persistent']);

// 删除动词。PowerShell 的 Remove-Item 别名一并收录（del / erase / rd / rmdir / rm / ri）。
const DELETE_VERBS = [
  'remove-item',
  'remove-itemproperty',
  'clear-content',
  'clear-item',
  'clear-recyclebin',
  'del',
  'erase',
  'rmdir',
  'rd',
  'rm',
  'unlink',
  'srm',
  'trash',
];

// 写盘 / 改盘动词：不删文件但会改变磁盘内容，同样要先让用户看懂再动手。
// 刻意只收多字母写法，不收 md / cp / mv 这类两字母别名——它们在路径片段里太容易误判。
const WRITE_VERBS = [
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'copy-item',
  'move-item',
  'rename-item',
  'set-itemproperty',
  'new-itemproperty',
  'robocopy',
  'xcopy',
  'mkdir',
  'tee',
  'tee-object',
  'install-package',
  'install-module',
  'chmod',
  'chown',
  'icacls',
  'takeown',
  'attrib',
  'git clean',
  'git reset',
  'git checkout',
  'git restore',
  'git stash',
  'git merge',
  'git rebase',
];

function verbRegex(list) {
  const body = list
    .map((v) => v.replace(/-/g, '\\-').replace(/\s+/g, '\\s+'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  // 前后必须是命令边界，避免 model / deleteLater 这类标识符被误判。
  return new RegExp(`(?:^|[\\s;&|(){}\\[\\]<>"\`'=,])(?:${body})(?=$|[\\s;&|(){}\\[\\]<>"\`'=,])`, 'i');
}

const DELETE_RE = verbRegex(DELETE_VERBS);
const WRITE_RE = verbRegex(WRITE_VERBS);

// 通配符：删除/写入命令里出现这些，说明动手范围在动手前没法逐项核对。
// 只把 * 当通配符。? 虽然也是 PowerShell 的通配符，但它在正常代码里太常见了
// （三元 `a ? b : c`、Where-Object 的别名 `?`、正则里的 ?），一律拦会疯狂误伤；
// 而单独用 ? 去删文件几乎没人这么写，危害也小得多（只匹配单个字符）。
// 实测过：一条带三元表达式（`a ? b : c`）的删除命令被误判成通配符永久拦死，故收窄。
const GLOB_RE = /\*/;

// ---- 纯白名单模式（readOnlyMode）用的只读命令表 -------------------------------
//
// 只收「看一眼就走」的命令：查询、筛选、格式化、度量。任何可能改盘的都不在里面。
// 特别注意没收的：sc（Set-Content 的别名）、tee（写文件）、node / npm / python
// （能跑任意代码，等于什么都能干）、新别名 ri / si / ni 之外的其它动词。
const READONLY_VERBS = new Set([
  // 列目录 / 读文件
  'get-childitem', 'get-content', 'get-item', 'get-itemproperty', 'get-location',
  'get-filehash', 'get-acl', 'resolve-path', 'join-path', 'split-path', 'convert-path',
  'test-path', 'get-psdrive', 'get-volume', 'get-disk', 'get-partition',
  // 进程 / 服务 / 网络 / 系统信息
  'get-process', 'get-service', 'get-ciminstance', 'get-wmiobject', 'get-computerinfo',
  'get-netadapter', 'get-nettcpconnection', 'get-netipaddress', 'test-connection',
  'get-host', 'get-date', 'get-random', 'get-variable', 'get-command', 'get-help',
  'get-member', 'get-module', 'get-alias', 'get-history',
  // 管道里的纯变换
  'select-string', 'select-object', 'where-object', 'foreach-object', 'measure-object',
  'sort-object', 'group-object', 'compare-object', 'format-table', 'format-list',
  'format-wide', 'out-string', 'out-host', 'out-null', 'write-output', 'write-host',
  'convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv',
  'convertto-html', 'split', 'start-sleep',
  // 别名（全是查询类）
  'dir', 'ls', 'gci', 'gc', 'cat', 'type', 'echo', 'pwd', 'gl', 'gi', 'gm', 'gps',
  'gsv', 'sls', 'select', 'where', 'fl', 'ft', 'fw', 'oh', 'gv', 'gcm',
  // 外部命令（只读）
  'findstr', 'tree', 'assoc', 'ftype', 'systeminfo', 'whoami', 'hostname',
]);

// git 单独处理：git 本身既能只读也能改盘（checkout / reset / clean），必须看子命令。
const READONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe',
  'ls-files', 'ls-tree', 'blame', 'shortlog', 'reflog', 'tag', 'whatchanged',
]);

// 按真正的命令分隔符切段。刻意也按单个 `|` 切：`Get-Content a | Remove-Item b`
// 只看首词会漏掉后面的删除。代价是 `Select-String -Pattern "a|b"` 这种带竖线的
// 正则会切成两段、第二段首词不在白名单而被误拦——误拦是安全方向，接受。
const SEG_SPLIT_RE = /\r?\n|;|&&|\|\||\|/;

/** 取一段命令的首个词（去掉前导的 & . 空白）。纯符号段返回空串。 */
function segFirstWord(seg) {
  const s = seg.trim().replace(/^[&.\s]+/, '');
  const m = /^([A-Za-z][A-Za-z0-9_.-]*)/.exec(s);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 找出第一段不属于只读的命令词。
 * 全部是只读 → 返回 undefined（放行）；否则返回那个越界的词（用于提示与日志）。
 */
function firstNonReadOnly(command) {
  for (const seg of command.split(SEG_SPLIT_RE)) {
    const w = segFirstWord(seg);
    if (!w) continue; // 花括号收尾、纯符号段
    if (w === 'git') {
      const m = /^git\s+([A-Za-z-]+)/i.exec(seg.trim().replace(/^[&.\s]+/, ''));
      const sub = m ? m[1].toLowerCase() : '';
      if (!READONLY_GIT.has(sub)) return `git ${sub || '?'}`;
      continue;
    }
    if (!READONLY_VERBS.has(w)) return w;
  }
  return undefined;
}

// 路径提取：盘符路径与 UNC 路径。前面必须是分隔符或行首，避免把 URL 里的部分当路径。
const PATH_RE = /(?:^|[\s"'=,;(\[@+{])((?:[A-Za-z]:[\\/]|\\\\)[^\s"'`,;|)<>\]}]*(?:\s[^\s"'`,;|)<>\]}]+)*)/g;

// 内置受保护名单只收「任何 Windows 机器上都成立」的系统目录，且用环境变量推导，
// 不硬编码盘符：系统盘不一定是 C:，Program Files / ProgramData 也可能被挪到别的盘。
// 盘根刻意**不**放进这个名单——任何盘的根目录都在 protectedHit() 里用正则统一拦死，
// 名单里写 C:\ D:\ 只会漏掉 E: F: 和插上来的 U 盘。
const SYSTEM_DRIVE = process.env.SystemDrive || 'C:';
const DEFAULT_PROTECTED = [
  path.win32.join(SYSTEM_DRIVE, 'Windows'),
  process.env.ProgramFiles,
  process.env['ProgramFiles(x86)'],
  process.env.ProgramData,
  path.win32.join(SYSTEM_DRIVE, 'Windows.old'),
  path.win32.join(SYSTEM_DRIVE, '$Recycle.Bin'),
  path.win32.join(SYSTEM_DRIVE, 'System Volume Information'),
  path.win32.join(SYSTEM_DRIVE, 'Recovery'),
  path.win32.join(SYSTEM_DRIVE, 'Boot'),
  path.win32.join(SYSTEM_DRIVE, 'PerfLogs'),
].filter((p) => typeof p === 'string' && p.length > 0);

export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('总开关。关掉后所有命令直接放行')
    .extra('volatile', true),
  policy: z
    .string()
    .default('default')
    .description(
      '守卫策略初始档位：low=只拦根目录/系统目录删除；default=删除命令拦一次；high=删除+修改都拦；readonly=只放行只读命令。' +
        '实际生效的是 /guard-low · /guard-default · /guard-high · /guard-readonly 命令或设置页写下的档位，这里是没写过时的兜底。',
    )
    .extra('volatile', true),
  guardWrites: z
    .boolean()
    .default(true)
    .description('除了删除，是否也拦写入/改盘命令（Set-Content / Copy-Item / robocopy / git reset 等）')
    .extra('volatile', true),
  allowSecondAttempt: z
    .boolean()
    .default(true)
    .description('普通删除/写入被拦一次后，原样重发同一条命令是否放行。关掉就只能由用户手动执行')
    .extra('volatile', true),
  protectedDirs: z
    .array(z.string())
    .default(DEFAULT_PROTECTED)
    .description('禁止删除/写入的目录（含其下所有内容）。盘根只做精确匹配，不会把整块盘都锁死')
    .extra('volatile', true),
  readOnlyMode: z
    .boolean()
    .default(false)
    .description('纯白名单模式：只放行查询类命令（Get-ChildItem / Get-Content / Select-String / git status 等），其余一律拦死。适合「只想让你看一眼、别动任何东西」的时候')
    .extra('volatile', true),
});

function normPath(p) {
  let s = String(p).trim().replace(/["'`]/g, '');
  if (!s) return '';
  try {
    s = path.win32.normalize(s);
  } catch {
    /* 归一化失败就用原串比 */
  }
  s = s.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(s)) s += '\\';
  return s.toLowerCase();
}

/** 从命令里抽出所有像路径的 token。 */
function extractPaths(command) {
  const out = [];
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(command)) !== null) {
    const raw = m[1].trim();
    if (raw) out.push(raw);
  }
  return out;
}

/** 这条命令命中的受保护目录（返回第一个命中的原始配置项）。 */
function protectedHit(command, protectedDirs) {
  const paths = extractPaths(command);
  if (paths.length === 0) return undefined;
  // 任何盘的根目录一律拦死——不只系统盘。U 盘、移动硬盘插上来也是盘根，
  // 名单里没写不代表能删（实测：只写死 C:\ D:\ 的名单会漏掉 U 盘盘根，
  // 删盘根只走了「第一次拦一次」，重发一次就放行了——这是漏洞，不是设计）。
  for (const raw of paths) {
    if (/^[a-z]:\\$/.test(normPath(raw))) return raw.trim();
  }
  // DSH 传下来的 config 里数组字段未必还是数组（实测受保护名单会变成不可迭代的对象），
  // 认不出来就退回内置默认名单——绝不能让 for...of 抛出去，那样整道门会变成报错。
  const lists =
    Array.isArray(protectedDirs) && protectedDirs.length > 0 ? protectedDirs : DEFAULT_PROTECTED;
  for (const list of lists) {
    const guard = normPath(list);
    if (!guard) continue;
    // "c:\" 这种盘根只能精确命中：它下面的一切都以它开头，用 startsWith 会把
    // 整块盘都判成禁区（C:\Users\... 也逃不掉），那等于什么都干不了。
    const isDriveRoot = /^[a-z]:\\$/.test(guard);
    const guardNoSlash = guard.replace(/[\\/]+$/, '');
    for (const raw of paths) {
      const p = normPath(raw);
      if (!p) continue;
      const pNoSlash = p.replace(/[\\/]+$/, '');
      if (isDriveRoot) {
        if (pNoSlash === guardNoSlash) return list;
        continue;
      }
      if (pNoSlash === guardNoSlash) return list;
      if (p.startsWith(guardNoSlash + '\\') || p.startsWith(guardNoSlash + '/')) return list;
    }
  }
  return undefined;
}

function extractCommand(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'script', 'cmd']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function shorten(s, n = 300) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

// 被拦过的命令：key = 种类 + 去空白的原文，value = 首次拦截时间戳。
// 只放行一次，放行后立刻删除，避免「一次点头删十次」。
const pending = new Map();
const PENDING_TTL = 60 * 60 * 1000;

function sweepPending(now) {
  for (const [key, at] of pending) {
    if (now - at > PENDING_TTL) pending.delete(key);
  }
}

// 被拦下、正等着重发放行的那批目标（归一化路径）。
// 按「目标」而不是「命令原文」记：同一条删除换个写法（加 -Force、拆成两条、
// 几条合并成一条）目标没变，就不该再拦一遍。
// 没有时间上限——用户可能扔一句「你看着办」就去忙了，回来才看，设个 30 分钟反而要重来。
// 成功执行一次后清空：确认的是「这一批」，不是「这个文件永久可删」。
let pendingTargets = null;

// 上一次被拦或放行时的那批目标，只用来做「这次多了什么」的对比，不构成授权。
let lastDeniedTargets = new Set();

// 档位说明只在本次会话第一次拦截时出现，之后不再重复刷屏。
let footerShown = false;

// ---- 三档文案 ----------------------------------------------------------------

function denyGlob(command, kind, policy) {
  return [
    '【dsh-fileguard 拦截】',
    '',
    '命令带了通配符，这条【不会放行】——重发多少次都一样，插件不会再问第二次。',
    '',
    `命令：${shorten(command)}`,
    '',
    kind === 'delete'
      ? '通配符的删除范围在删之前没法逐项核对：你不知道会命中哪些文件，用户也看不清会丢什么。'
      : '通配符的写入范围在写之前没法逐项核对：会覆盖哪些文件你看不出来，用户也看不出来。',
    '不要用 * 或 ?。正确做法：先用 glob / Get-ChildItem 把实际命中的清单列出来给用户看，',
    '让用户挑，然后对具体的那几个文件逐个点名操作。',
    policyFooter(policy),
  ].join('\n');
}

/** 档位说明只在本次进程第一次拦截时出现，之后不再重复刷屏。 */
function policyFooter(policyKey) {
  if (footerShown) return '';
  footerShown = true;
  const cur = POLICY_META.find((p) => p.key === policyKey) ?? POLICY_META[1];
  return [
    '',
    `当前档位：${cur.label}（${cur.key}）— ${cur.summary}`,
    '换档：/guard-low · /guard-default · /guard-high · /guard-readonly（风险低 → 高）',
  ].join('\n');
}

function denyProtected(command, dir, policy) {
  // 盘根和系统目录要说两套话：盘根是「整块盘」，系统目录才是「Windows 的地盘」。
  const isDriveRoot = /^[a-z]:\\$/i.test(String(dir ?? '').trim());
  if (isDriveRoot) {
    const letter = String(dir).trim().slice(0, 2).toUpperCase();
    return [
      '【dsh-fileguard 拦截】',
      '',
      `目标是盘根（${dir}），所有档位都不放行——重发多少次都一样。`,
      '',
      `命令：${shorten(command)}`,
      '',
      `盘根下面就是这整块盘的全部内容（${letter} 盘里所有目录和文件），删它等于把这块盘清空。`,
      '这不是「再问一次就放行」的那一类，别浪费时间重试。',
      '',
      '正确做法是往下走一层：用 Get-ChildItem / glob 把里面的具体目录或文件列出来，',
      '让用户自己挑要删哪些，再对具体路径逐个点名操作。',
      '把这个后果原样告诉用户，别自己找替代路径绕过。',
    ].join('\n');
  }
  return [
    '【dsh-fileguard 拦截】',
    '',
    `目标落在系统目录（${dir}），high 档下不放行。`,
    '',
    `命令：${shorten(command)}`,
    '',
    `${dir} 归 Windows 所有：动里面的东西轻则某个程序打不开，重则系统起不来；`,
    '而且大量文件被系统占用，硬来通常只会报一堆 Access Denied，什么也干不成。',
    '',
    '如果确实需要改这里，让用户把档位切到 /guard-default 或 /guard-low，',
    '届时这条命令会走「拦一次 → 你说明 → 用户点头 → 原样重发才放行」的流程。',
    '不要自己找替代路径绕过。',
    policyFooter(policy),
  ].join('\n');
}

function denyFirstTime(command, kind, risk, policy, targets) {
  const isWrite = kind === 'write';
  const lines = [
    '【dsh-fileguard 拦截】',
    '',
    '这条命令被守卫插件拦下了——不是沙箱拒绝，不是权限不足，也不是命令写错了。',
    `插件只是在等你说清楚。${isWrite ? '这次什么都没写。' : '这次什么都没删。'}`,
    '',
    `命令：${shorten(command)}`,
  ];
  if (targets && targets.length) {
    lines.push('', `这次要确认的目标：${targets.map((p) => shorten(p, 120)).join('；')}`);
  }
  if (risk) lines.push(`目标：${risk}（系统目录。high 档会硬拦，当前档位由你说明后放行）`);
  lines.push(
    '',
    '接下来这样做：',
    '',
    `1) 说明。${isWrite
      ? '讲清楚改哪个文件（完整路径）、改成什么、为什么非改不可、改坏了怎么恢复、有没有更轻的做法。'
      : '讲清楚这是什么东西、有什么用、删掉之后会怎样；确实没影响就直说「可以放心清理」。'}`,
    '2) 别改命令绕。目标没变的话，加参数、拆开、几条并成一条都算同一条，重发就放行；',
    '   但别趁重发偷偷多删用户没提的东西。',
    '3) 手上还有跟这条无关、也不依赖它结果的操作，可以先去做——',
    '   别为了一条被拦的命令把整个任务卡住；记住有哪几条被拦了。',
    '4) 收尾时统一汇报：把被拦的每一条、各自的影响一次性讲给用户，让他一次确认；',
    '   点头后逐条重发即放行（这一批在你真的执行之前一直有效，不用赶时间）。',
    policyFooter(policy),
  );
  return lines.join('\n');
}

/**
 * 同一批目标又多出来几个：让模型自己判断这是「用户额外要求」还是「自己顺手扩大」。
 * 这种情况最常见——用户说「顺便把 X 也删了」，那不是新任务，是同一次许愿，
 * 再让他为已经说过的话点一次头就很烦。
 */
function denyExtraTargets(command, extra, policy) {
  return [
    '【dsh-fileguard 拦截】',
    '',
    `本次命令还将额外删除：${extra.map((p) => shorten(p, 120)).join('；')}`,
    '',
    '自己判断就行，不用再问用户一遍：',
    '- 是用户明确要删的（比如他刚说「顺便把 X 也删了」）→ 原样重发，第二次放行。',
    '- 是你自己顺手扩大的范围 → 去掉再发，别把用户没提的东西一起删了。',
    policyFooter(policy),
  ].join('\n');
}

// ---- 主判定 ------------------------------------------------------------------

function denyReadOnly(command, word, policy) {
  return [
    `只读模式开着，这条【不会放行】（卡在 \`${word}\`）。`,
    '',
    `命令：${shorten(command)}`,
    '',
    '只读模式下只放行查询类命令：Get-ChildItem / Get-Content / Select-String / Test-Path /',
    'Get-Process / git status / git log 这一类。任何写盘、改权限、跑脚本（node / npm /',
    'python）的都不放行——重发多少次都一样，这个不是在等你解释。',
    '要真正动手，请让用户切到别的档位：/guard-default 或 /guard-high（在聊天框直接打）。',
    '如果只是想确认某个文件/目录里有什么，用 read / glob / grep 这些原生工具就够，不必用命令。',
    policyFooter(policy),
  ].join('\n');
}

// ---- AI 创建台账 --------------------------------------------------------------
// 为什么不把「AI 创建时间」写进文件本身：临时文件里有大量二进制（截图、PDF、
// 导出的表格、压缩包），往文件头塞一行元数据会直接损坏它们；而且本插件只在命令
// 执行前看一眼，没有机会参与生成文件，根本写不进去。
// 所以改成旁路记账：看到「要写某个路径」就记一笔，删除时查账。
// 只看台账、不看 birthtime——原子写（写临时文件再改名覆盖）会让老文件的创建时间
// 变新，拿时间戳判断会被骗；台账记的是「我见过谁要写这个路径」，骗不了。
const CREATED_FILE = process.env.DSH_FILEGUARD_CREATED ?? path.join(PLUGIN_DIR, 'ai-created.json');
const CREATED_MAX = 5000; // 账本上限，超了按时间淘汰最旧的
let createdCache = null;

/** 台账用的键：绝对化 + 归一 + 小写。相对路径按本进程 cwd 解析；记账和查账走
 *  同一个函数，所以「记的时候是绝对、删的时候是相对」也能对上。 */
function ledgerKey(p) {
  if (!p || typeof p !== 'string') return '';
  try {
    return normPath(path.resolve(p));
  } catch {
    return normPath(p);
  }
}

function readCreated() {
  if (createdCache !== null) return createdCache;
  try {
    const raw = JSON.parse(fs.readFileSync(CREATED_FILE, 'utf8'));
    const files = raw?.files;
    createdCache = files && typeof files === 'object' && !Array.isArray(files) ? { ...files } : {};
  } catch {
    createdCache = {};
  }
  return createdCache;
}

function writeCreated(map) {
  try {
    const keys = Object.keys(map);
    let next = map;
    if (keys.length > CREATED_MAX) {
      const keep = keys.sort((a, b) => Number(map[b]) - Number(map[a])).slice(0, CREATED_MAX);
      const pruned = {};
      for (const k of keep) pruned[k] = map[k];
      next = pruned;
    }
    fs.mkdirSync(path.dirname(CREATED_FILE), { recursive: true });
    fs.writeFileSync(CREATED_FILE, JSON.stringify({ version: 1, files: next }, null, 2) + '\n', 'utf8');
    createdCache = next;
  } catch (e) {
    log(`CREATED-WRITE-FAIL ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 记下「这些路径是 AI 要写/建的」。写盘失败只记日志，不影响主流程。 */
function markCreated(paths, by) {
  const map = { ...readCreated() };
  const now = Date.now();
  let added = 0;
  for (const p of paths) {
    if (!p || GLOB_RE.test(p)) continue; // 通配符记不了；它本来也不放行
    const k = ledgerKey(p);
    if (!k || map[k]) continue;
    map[k] = now;
    added += 1;
  }
  if (added > 0) {
    writeCreated(map);
    log(`CREATED +${added} by=${by}`);
  }
}

/** 这批目标是否全都登记在台账上、且时间在窗口内。 */
function allAiCreated(paths, hours) {
  if (paths.length === 0) return { ok: false, missing: [] };
  const map = readCreated();
  const cutoff = Date.now() - hours * 3600 * 1000;
  const missing = [];
  for (const p of paths) {
    if (GLOB_RE.test(p)) {
      missing.push(p);
      continue;
    }
    const at = Number(map[ledgerKey(p)]);
    if (!(at > 0) || at < cutoff) {
      missing.push(p);
      continue;
    }
    // 目录不放行：刚 clone 的仓库、刚解压的包、刚生成的结果目录同样会被记进台账，
    // 但它们不是「一次性的临时文件」，删错的代价大得多。只放行普通文件。
    try {
      if (fs.statSync(p).isDirectory()) missing.push(p);
    } catch {
      /* 已经不存在了：删它不会有副作用，按台账处理 */
    }
  }
  return { ok: missing.length === 0, missing };
}

/** 从 write / edit 这类工具的入参里取目标路径（各版本字段名不一样，全试一遍）。 */
function toolWritePath(args) {
  if (!args || typeof args !== 'object') return null;
  for (const key of ['file_path', 'filePath', 'path', 'target', 'filename']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function check(exec, config) {
  const toolName = exec?.name;
  if (typeof toolName !== 'string') return undefined;

  // 不是 shell 的工具（write / edit / …）：不拦——用户明确要求这些不受管辖——
  // 但如果它在写文件就记一笔账，以后删它建的临时文件时就不用再问一遍。
  if (!SHELL_TOOLS.has(toolName)) {
    if (config?.enabled !== false) {
      const p = toolWritePath(exec?.arguments);
      if (p) markCreated([p], toolName);
    }
    return undefined;
  }

  const command = extractCommand(exec?.arguments);
  if (!command) return undefined;

  // 总开关关掉时什么都不拦（对模型完全无感）。
  if (config?.enabled === false) return undefined;

  const policy = resolvePolicy(config);

  // 0) 纯白名单档：优先级最高，整条命令必须全是查询类才放行。
  //    老字段 readOnlyMode 仍然认，等价于 policy='readonly'。
  if (policy === 'readonly' || config?.readOnlyMode === true) {
    const bad = firstNonReadOnly(command);
    if (!bad) return undefined;
    log(`DENY(readonly:${bad}) tool=${toolName} cmd=${shorten(command, 200)}`);
    return denyReadOnly(command, bad, policy);
  }

  const isDelete = DELETE_RE.test(command);
  const isWrite = !isDelete && WRITE_RE.test(command);
  if (!isDelete && !isWrite) return undefined;

  const kind = isDelete ? 'delete' : 'write';

  // 1) 通配符：永不放行，不进 pending。
  if (GLOB_RE.test(command)) {
    log(`DENY(glob,${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
    return denyGlob(command, kind, policy);
  }

  // 2) 盘根 / 系统目录。
  //    盘根：所有档位都不放行（删整块盘没有「问一次」的说法）。
  //    系统目录：high 档不放行；low / default 走下面的「拦一次」流程，
  //    也就是 Agent 说明后用户点头、原样重发才放行。
  const hit = protectedHit(command, config?.protectedDirs);
  if (hit) {
    const isDriveRoot = /^[a-z]:\\$/i.test(String(hit).trim());
    if (isDriveRoot || policy === 'high') {
      const tag = isDriveRoot ? 'root' : 'sys';
      log(`DENY(protected:${tag}:${hit},${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
      return denyProtected(command, hit, policy);
    }
  }

  const paths = extractPaths(command);

  // 记一笔账：这条命令要写/建哪些路径。命令可能失败，记了也无害——删一个不存在的
  // 文件本来就不会发生什么事。
  if (isWrite) markCreated(paths, toolName);

  // AI 自己建的临时文件：low / default 档下直接放行，不用再问一遍。
  // 模型干活时会写一堆一次性的脚本、日志、截图、探测文件，删它们再让用户点一次头
  // 纯属浪费——用户也未必看得懂那些临时文件是干嘛的。
  // 只认台账上登记过的路径：用户自己新建的文件不在账上，照样要确认。
  const tempH = tempHours(config);
  if (isDelete && (policy === 'low' || policy === 'default') && tempH > 0) {
    const ledger = allAiCreated(paths, tempH);
    if (ledger.ok) {
      log(`ALLOW(ai-created:${paths.length},${tempH}h) tool=${toolName}`);
      return undefined;
    }
  }

  // 4) 目标级放行：这条命令里的目标如果全都在「已经点头过」的集合里，直接过。
  //    为的是两件事：同一条删除换个写法（拆开/合并）别再拦一遍；
  //    用户说「顺便把 C 也删了」时，A B 已经确认过，只该问 C。
  const normed = paths.map((p) => normPath(p));
  const normSet = new Set(normed.filter(Boolean));
  const now = Date.now();

  // 5) 刚才被拦下的那批目标又回来了（原样重发、或换个写法）→ 放行，授权当场用掉。
  if (config?.allowSecondAttempt !== false) {
    if (pendingTargets && normSet.size > 0) {
      const allIn = [...normSet].every((p) => pendingTargets.has(p));
      const anyIn = [...normSet].some((p) => pendingTargets.has(p));
      if (allIn) {
        pendingTargets = null;
        lastDeniedTargets = normSet;
        log(`ALLOW(second-targets,${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
        return undefined;
      }
      if (anyIn && !hit) {
        // 同一批又加了几个：让模型自己判断是用户额外要求，还是自己顺手扩大。
        const extra = [...normSet].filter((p) => !pendingTargets.has(p));
        pendingTargets = normSet;
        lastDeniedTargets = normSet;
        log(`DENY(extra-targets:${extra.length}) tool=${toolName} cmd=${shorten(command, 200)}`);
        return denyExtraTargets(command, extra, policy);
      }
    } else {
      // 命令里抽不出路径（git clean、robocopy 这类），只能按命令原文认。
      const key = `${kind}\u0000${command.replace(/\s+/g, ' ').trim()}`;
      sweepPending(now);
      if (pending.has(key)) {
        pending.delete(key);
        lastDeniedTargets = normSet;
        log(`ALLOW(second,${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
        return undefined;
      }
    }
  }

  // 4) 档位决定普通删除 / 写入要不要拦：
  //    low     —— 只硬拦盘根；系统目录仍然拦一次（命中 hit 时不在这里放行）
  //    default —— 拦删除；系统目录同样拦一次
  //    high    —— 删除和写入都拦（read / write / edit 工具本来就不在管辖范围）
  if (!hit) {
    if (policy === 'low') return undefined;
    if (isWrite && policy !== 'high') return undefined;
  }

  // 5) 拦下，把这批目标记成「等重发」。
  pendingTargets = normSet.size > 0 ? normSet : null;
  lastDeniedTargets = normSet;
  sweepPending(now);
  pending.set(`${kind}\u0000${command.replace(/\s+/g, ' ').trim()}`, now);

  const why = hit ? `first-protected:${hit}` : 'first';
  log(`DENY(${why},${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
  return denyFirstTime(command, kind, hit || undefined, policy, paths);
}

/** 一条斜杠命令对应一档，名字里就带档位——聊天框里打 /guard 能把四条一起列出来。 */
function policyCommandDefinition(meta) {
  return {
    name: meta.command,
    description: `文件守卫策略切到「${meta.label}」：${meta.summary}。切换即刻生效，不用重启。`,
    handler() {
      if (!writePolicyFile(meta.key)) {
        return { kind: 'error', text: `写入 ${POLICY_FILE} 失败，档位没变。` };
      }
      return {
        kind: 'success',
        text: `文件守卫策略 = ${meta.label}（${meta.key}）：${meta.summary}\n已生效，不用重启。`,
      };
    },
  };
}

/** 从斜杠命令的 invocation 里尽力取参数。各版本命令平面的字段名不一样，全试一遍。 */
function invocationArg(invocation) {
  if (invocation === null || typeof invocation !== 'object') return '';
  for (const key of ['args', 'rest', 'text', 'raw', 'input', 'argument', 'params']) {
    const v = invocation[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (Array.isArray(v) && v.length > 0) return v.map(String).join(' ').trim();
  }
  return '';
}

/** /guard-temp [小时] —— 看或改「AI 建的临时文件」免审窗口。不带数字则循环切换。 */
function tempCommandDefinition() {
  return {
    name: 'guard-temp',
    description:
      `AI 建的临时文件免审窗口：low / default 档下，删除台账上登记过、且时间在窗口内的文件直接放行，不再拦一次。默认 ${TEMP_HOURS_DEFAULT} 小时，0 = 关掉。用法：/guard-temp 4 设成 4 小时；不带数字则循环切换（1 → 4 → ${TEMP_HOURS_DEFAULT} → 24 → 72 → 关）。`,
    handler(invocation) {
      const raw = invocationArg(invocation);
      const cur = tempHours(undefined);
      let next;
      if (raw !== '') {
        const digits = raw.replace(/[^0-9.]/g, '');
        const n = digits === '' ? Number.NaN : Number(digits);
        if (!Number.isFinite(n) || n < 0) {
          return {
            kind: 'error',
            text: `看不懂「${raw}」。给个小时数就行，比如 /guard-temp 4；0 = 关掉这个机制。`,
          };
        }
        next = Math.min(n, TEMP_HOURS_MAX);
      } else {
        const presets = [1, 4, TEMP_HOURS_DEFAULT, 24, 72, 0];
        const idx = presets.indexOf(cur);
        next = idx >= 0 ? presets[(idx + 1) % presets.length] : TEMP_HOURS_DEFAULT;
      }
      if (!patchPolicyFile({ tempHours: next })) {
        return { kind: 'error', text: `写入 ${POLICY_FILE} 失败，窗口没变。` };
      }
      log(`TEMP_HOURS=${next}`);
      return {
        kind: 'success',
        text:
          next === 0
            ? `AI 临时文件免审已关闭（原来是 ${cur} 小时）：从现在起每次删除都要走一遍确认。`
            : `AI 临时文件免审窗口 = ${next} 小时（原来是 ${cur}）。只对台账上登记过、且是 AI 自己写出来的文件生效；用户新建的文件、目录、通配符照旧要确认。`,
      };
    },
  };
}

export function apply(ctx, config) {
  log(`apply; tools=${typeof ctx?.tools} enabled=${config?.enabled !== false} policy=${resolvePolicy(config)}`);
  ctx.tools.guard((exec) => check(exec, config));

  // 斜杠命令是可选的 commands 服务，可能比本插件晚就绪（fiber 并发启动竞态），
  // 所以立即试一次，再每秒重试，最多 20 次。注册挂 ctx.effect：热重载自动注销。
  const tryRegister = (attempt) => {
    const commands = ctx.get?.('commands');
    if (commands !== undefined && typeof commands.register === 'function') {
      for (const meta of POLICY_META) {
        try {
          ctx.effect(() => commands.register(policyCommandDefinition(meta)));
        } catch (e) {
          log(`cmd ${meta.command} FAIL ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        ctx.effect(() => commands.register(tempCommandDefinition()));
      } catch (e) {
        log(`cmd guard-temp FAIL ${e instanceof Error ? e.message : String(e)}`);
      }
      log(`commands: ${POLICY_META.map((m) => '/' + m.command).join(' ')} /guard-temp`);
      return;
    }
    if (attempt < 20) setTimeout(() => tryRegister(attempt + 1), 1000);
    else log('commands 服务 20s 内未就绪，/guard-* 未注册（守卫本身不受影响）');
  };
  tryRegister(0);
}
