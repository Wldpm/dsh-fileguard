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
// 四档设计。切换走 /guard-* 斜杠命令，档位只存内存（原因见下面 currentPolicy 那段）。config 里的 policy 只当兜底初值。
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 状态目录：档位、窗口、token、台账全塞这里。
// 守卫对它的**任何工具访问都拦死，连读都不给**——模型只要能读一眼 token 文件，
// 整套放行机制就白做了；能写一笔 policy.json 就自己把档位切到 low 了。
// 要改由用户在设置页里改（设置页走的是插件内部 API，不经过 tools.guard）。
const STATE_DIR = process.env.DSH_FILEGUARD_STATE ?? path.join(PLUGIN_DIR, 'state');

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

// 档位 / 免审窗口 / 守卫开关都存在 **plugin Config** 里（设置页可改、`/guard-*` 可改）。
// 早期版本存在 state/policy.json，但那样设置页就改不动（client 只能写 config），
// 所以改成 config 单一来源。state/ 只留 tokens.json 与 ai-created.json 两样
// ——它们才是「让模型拿到就等于破防」的东西，档位不算。
const TEMP_HOURS_DEFAULT = 8;
const TEMP_HOURS_MAX = 720; // 30 天，再长就不算「临时」了

/** 插件自己的 ctx，apply 时存一份，给斜杠命令改配置用（handler 拿不到 ctx）。 */
let pluginCtx = null;

/**
 * 把若干字段写回本插件的 loader entry。
 * configEditor.edit 是 async，而 command handler 必须同步返回，
 * 所以这里 fire-and-forget：改完 loader 会重载本插件，一两秒后生效。
 */
function patchConfig(patch) {
  const editor = pluginCtx?.get?.('configEditor');
  if (editor === undefined || typeof editor.edit !== 'function') return false;
  let row = null;
  try {
    row = editor.entries().find((e) => e?.options?.id === NS) ?? null;
  } catch {
    row = null;
  }
  if (row === null) return false;
  void editor
    .edit(row, (current) => ({ ...(current ?? {}), ...patch }))
    .then(() => log(`CONFIG ${JSON.stringify(patch)}`))
    .catch((e) => log(`CONFIG-WRITE-FAIL ${e instanceof Error ? e.message : String(e)}`));
  return true;
}

/** 临时文件免审窗口（小时）。0 = 关掉这个机制。 */
function tempHours(config) {
  const n = config?.tempHours;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.min(n, TEMP_HOURS_MAX);
  return TEMP_HOURS_DEFAULT;
}

/** 当前生效档位：直接读 config.policy。 */
function resolvePolicy(config) {
  const p = String(config?.policy ?? '').toLowerCase();
  return POLICY_KEYS.includes(p) ? p : 'default';
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
// ops_bash 是 dsh-ops 插件注册的 shell 工具（参数同样是 command），必须一起管——
// 不管的话一句 ops_bash 就能绕开整套守卫。
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'terminal', 'pwsh_persistent', 'bash_persistent', 'ops_bash']);

// 能自己写文件的非 shell 工具。它们没有命令行，靠参数里的路径判断。
const WRITE_TOOL_RE = /^(write|edit|str_replace_editor|apply_patch|multi_edit)$/;

// ── dsh-ops 工具集 ──────────────────────────────────────────────────────────
// ops 插件（<profile>/node_modules/dsh-ops）注册的工具和原生工具能力等价，
// 名字前缀 `ops_` 在 dsh-ops/lib/policy.js 里硬编码（TOOL_PREFIX），不会变。
// 不接管它们，一句 ops_remove / ops_batch 就能把整套守卫绕过去。
//   ops_remove / ops_move                                       删 / 挪走源文件
//   ops_write_file / ops_edit_file / ops_replace / ops_copy     写盘
//   ops_batch  action=run 时批量 copy / move / remove（最大的一扇后门）
const OPS_DELETE_TOOLS = new Set(['ops_remove', 'ops_move']);
const OPS_WRITE_TOOLS = new Set(['ops_write_file', 'ops_edit_file', 'ops_replace', 'ops_copy']);
const OPS_BATCH_TOOL = 'ops_batch';
// 兜底：dsh-ops 以后新增的变更类工具，名字里带这些词就按变更处理——
// 宁可多拦一次，也别让新工具成为新的后门。
const OPS_MUTATION_NAME_RE = /(write|edit|replace|copy|move|remove|delete|rename|truncate|batch)/;

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
  // git clean 是真删文件（删未跟踪文件），不是"改盘"。归到写操作的话
  // 默认档会直接放行，等于一句话把整个仓库里没提交的东西清空。
  'git clean',
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
// 只把 * 当通配符。? 虽然也是 PowerShell 的通配符，但它在正常代码里太常见
// （三元 `a ? b : c`、Where-Object 的别名 `?`、正则里的 ?），一律拦会疯狂误伤；
// 而单独用 ? 去删文件几乎没人这么写，危害也小得多（只匹配单个字符）。
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
      '守卫强度：low=只拦盘根/系统目录删除；default=删除命令拦一次；high=删除+修改都拦；readonly=只放行只读命令。设置页和 /guard-* 命令改的都是这一项。',
    )
    .extra('volatile', true),
  tempHours: z
    .number()
    .default(TEMP_HOURS_DEFAULT)
    .description(
      `AI 自己写的临时文件免审窗口（小时）。窗口内删除台账里登记过的文件直接放行，0 = 关掉这个机制。上限 ${TEMP_HOURS_MAX}。`,
    )
    .extra('volatile', true),
  hintResetAt: z
    .number()
    .default(0)
    .description(
      '提示词初始化：把它改成一个新的时间戳（设置页点一下即可），下一次拦下时会重新显示那些「只在首次出现」的说明（档位脚注等）。',
    )
    .extra('volatile', true),
  devMode: z
    .boolean()
    .default(false)
    .description(
      '开发者模式：完全不拦，只记日志（含 state/ 目录）。给调试用——开着等于没有守卫，用完记得关。',
    )
    .extra('volatile', true),
  protectedDirs: z
    .array(z.string())
    .default(DEFAULT_PROTECTED)
    .description('禁止删除/写入的目录（含其下所有内容）。盘根只做精确匹配，不会把整块盘都锁死')
    .extra('volatile', true),
  readOnlyMode: z
    .boolean()
    .default(false)
    .description('纯白名单模式（等同 policy=readonly），保留兼容旧配置')
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
  return protectedHitPaths(extractPaths(command), protectedDirs);
}

/**
 * 这批路径里有没有盘根（C:\、E:\ 之类）。
 * 盘根只对**删除**有意义：删盘根等于清空整块盘，往盘根里放文件不是毁灭性操作。
 * 所以这个函数只在 isDelete 的路径上调用，不参与写入判定。
 */
function driveRootHit(rawPaths) {
  for (const raw of rawPaths ?? []) {
    const p = String(raw);
    if (p.length > 0 && /^[a-z]:\\$/.test(normPath(p))) return p.trim();
  }
  return undefined;
}

/** 同上，但直接收路径数组——给非 shell 工具（write / edit）用。 */
function protectedHitPaths(rawPaths, protectedDirs) {
  const paths = (rawPaths ?? []).map((s) => String(s)).filter((s) => s.length > 0);
  if (paths.length === 0) return undefined;
  // config 里的数组字段未必真的还是数组（可能被序列化成对象），
  // 认不出来就退回内置默认名单——不能让 for...of 抛出去，否则整道门变成报错。
  const lists =
    Array.isArray(protectedDirs) && protectedDirs.length > 0 ? protectedDirs : DEFAULT_PROTECTED;
  for (const list of lists) {
    const guard = normPath(list);
    if (!guard) continue;
    // "c:\" 这种盘根只能精确命中：它下面的一切都以它开头，用 startsWith 会把
    // 整块盘都判成禁区（用户目录也逃不掉），那等于什么都干不了。
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
  // ops_bash 允许只给 script_path（ops 扩展参数），这时没有命令行可看。
  // 造一个等价命令出来，后面的动词匹配、路径抽取、token 比对才有东西可用。
  if (typeof args.script_path === 'string' && args.script_path.trim()) {
    return `bash ${args.script_path.trim()}`;
  }
  return '';
}

function shorten(s, n = 300) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

// 早期版本用「拦一次 → 原样重发就放行」+ pending 表来实现，
// 那条路上模型自己重发两次就能绕过守卫，已整体换成 token 机制（见下面 TOKENS_* 一段）。
// pending / pendingTargets / lastDeniedTargets / denyExtraTargets 全部废弃删除。

// 档位说明只在本次会话第一次拦截时出现，之后不再重复刷屏。
let footerShown = false;
// 设置页「提示词初始化」写时间戳到这里，比上次大就允许脚注再出现一次。
let hintMark = 0;
// apply 时存一份 config，供 policyFooter 这类深处函数读（省得把 config 一路透传）。
let pluginConfig = null;

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
  // 提示词初始化：设置页把 hintResetAt 改成新时间戳后，下一次拦截重新显示脚注。
  const mark = Number(pluginConfig?.hintResetAt) || 0;
  if (mark > hintMark) {
    hintMark = mark;
    footerShown = false;
    log(`HINT-RESET mark=${mark}`);
  }
  if (footerShown) return '';
  footerShown = true;
  const cur = POLICY_META.find((p) => p.key === policyKey) ?? POLICY_META[1];
  return [
    '',
    `当前档位：${cur.label}（${cur.key}）— ${cur.summary}`,
    '换档：/guard-low · /guard-default · /guard-high · /guard-readonly（风险低 → 高）',
  ].join('\n');
}

function denyProtected(command, dir, policy, isDelete = false) {
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
  const head = isDelete
    ? `目标是系统目录（${dir}）里的删除，所有档位都不放行——包括低守卫。`
    : `目标落在系统目录（${dir}），high 档下不放行。`;
  const tail = isDelete
    ? [
        '系统目录里的东西删掉基本找不回来，也没有哪个档位能给它兜底：低守卫的定义就是',
        '「只硬拦盘根和系统目录」，所以切档也解决不了这条。',
        '盘根和系统目录的删除是这层守卫里唯二真正硬的两条线，重发多少次都不会变。',
      ]
    : [
        '如果确实需要改这里，让用户把档位切到 /guard-default 或 /guard-low。',
        '届时这条命令会走「拦一次 → 你说明 → 用户执行 /guard-gettoken 把 token 给你 → 带 token 重发」的流程。',
      ];
  return [
    '【dsh-fileguard 拦截】',
    '',
    head,
    '',
    `命令：${shorten(command)}`,
    '',
    `${dir} 归 Windows 所有：动里面的东西轻则某个程序打不开，重则系统起不来；`,
    '而且大量文件被系统占用，硬来通常只会报一堆 Access Denied，什么也干不成。',
    '',
    ...tail,
    '不要自己找替代路径绕过。',
    ...(isDelete ? [] : ['', policyFooter(policy)]),
  ].join('\n');
}

function denyFirstTime(command, kind, risk, policy, targets, token) {
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
  if (risk) lines.push(`目标：${risk}（系统目录。这里只允许改、不允许删，high 档连写入也硬拦）`);
  lines.push(
    '',
    '接下来这样做：',
    '',
    `1) 说明。${isWrite
      ? '讲清楚改哪个文件（完整路径）、改成什么、为什么非改不可、改坏了怎么恢复、有没有更轻的做法。'
      : '讲清楚这是什么东西、有什么用、删掉之后会怎样；确实没影响就直说「可以放心清理」。'}`,
    '2) 请用户放行。告诉他：在输入框执行 /guard-gettoken 拿到一串 token，然后把这串打给你。',
    '   放行的凭据只有用户能拿到，你没法自己生成——这一步不能跳。',
    '3) 拿到 token 后把命令原样重发，末尾加注释（不影响执行）：',
    '      Remove-Item ... # fg:<那串 token>',
    '   token 只放行这一次拦下的这批目标，用掉即废；目标里多出别的东西就得再要一个。',
    '4) 手上还有跟这条无关、也不依赖它结果的操作，可以先去做——',
    '   别为了一条被拦的命令把整个任务卡住；记住有哪几条被拦了，收尾时统一汇报。',
    policyFooter(policy),
  );
  lines.push(
    '',
    token !== null && token !== undefined
      ? '这一批的 token 已经生成好了，用户执行 /guard-gettoken 就能看到。'
      : '⚠️ 这次没能生成 token（插件目录不可写，或命令里抽不出路径）。让用户执行 /guard-gettoken 看看，没有的话查插件日志。',
  );
  return lines.join('\n');
}

/**
 * ops_* 工具被拦时的文案。
 *
 * 和 denyFirstTime 的区别只有一条：ops 工具没有命令行，模型没地方抄 `# fg:<token>`。
 * 所以这里不能说「把 token 加在命令末尾重发」，否则模型会一直照着做、一直失败。
 * 放行条件改成「用户执行过 /guard-gettoken（那串 token 被标记为看过）」，
 * 然后模型**原封不动重发同一个调用**即可——token 由守卫在内部对上。
 */
function denyOpsFirstTime(toolName, kind, risk, policy, targets, token) {
  const isWrite = kind === 'write';
  const lines = [
    '【dsh-fileguard 拦截】',
    '',
    `这条 ${toolName} 调用被守卫插件拦下了——不是沙箱拒绝，不是权限不足，也不是参数写错了。`,
    `插件只是在等你说清楚。${isWrite ? '这次什么都没写。' : '这次什么都没删。'}`,
    '',
    `工具：${toolName}`,
  ];
  if (targets && targets.length) {
    lines.push('', `这次要确认的目标：${targets.map((p) => shorten(p, 120)).join('；')}`);
  }
  if (risk) lines.push(`目标：${risk}（系统目录。这里只允许改、不允许删，high 档连写入也硬拦）`);
  lines.push(
    '',
    '接下来这样做：',
    '',
    `1) 说明。${isWrite
      ? '讲清楚改哪个文件（完整路径）、改成什么、为什么非改不可、改坏了怎么恢复、有没有更轻的做法。'
      : '讲清楚这是什么东西、有什么用、删掉之后会怎样；确实没影响就直说「可以放心清理」。'}`,
    '2) 请用户放行。告诉他：在输入框执行 /guard-gettoken 拿到一串 token，然后把这串打给你。',
    '   放行的凭据只有用户能拿到，你没法自己生成——这一步不能跳。',
    '3) 用户把 token 打给你之后，**把这次调用原样重发一遍**，一个参数都别改。',
    '   ops 工具的参数是封闭 schema，没有地方能塞 token，守卫会在内部对上——',
    '   你不需要、也没法在参数里写 `# fg:<token>`。',
    '   token 只放行这一次拦下的这批目标，用掉即废；目标里多出别的东西就得再要一个。',
    '4) 手上还有跟这条无关、也不依赖它结果的操作，可以先去做——',
    '   别为了一条被拦的调用把整个任务卡住；记住有哪几条被拦了，收尾时统一汇报。',
    policyFooter(policy),
  );
  lines.push(
    '',
    token !== null && token !== undefined
      ? '这一批的 token 已经生成好了，用户执行 /guard-gettoken 就能看到。'
      : '⚠️ 这次没能生成 token（插件目录不可写，或这次调用里抽不出目标）。让用户执行 /guard-gettoken 看看，没有的话查插件日志。',
  );
  return lines.join('\n');
}

function denyReadOnly(command, word, policy) {
  return [
    '【dsh-fileguard 拦截】',
    '',
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
//
// 台账存在 state/ai-created.json。守卫对整个 state 目录的访问一律拦死（见 touchesState），
// 模型写不进去也读不出来——所以放盘上不怕它自己塞一条「这个用户文件是我建的」。
const CREATED_FILE = path.join(STATE_DIR, 'ai-created.json');
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
  const map = Object.create(null);
  try {
    const doc = JSON.parse(fs.readFileSync(CREATED_FILE, 'utf8'));
    if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
      for (const [k, v] of Object.entries(doc)) {
        if (k !== '' && typeof v === 'number' && Number.isFinite(v)) map[k] = v;
      }
    }
  } catch {
    // 坏文件 / 不存在都当空台账：宁可多拦一次，也别把旧的当成授权
  }
  createdCache = map;
  return map;
}

function writeCreated(map) {
  const keys = Object.keys(map);
  let next = map;
  if (keys.length > CREATED_MAX) {
    const keep = keys.sort((a, b) => Number(map[b]) - Number(map[a])).slice(0, CREATED_MAX);
    next = Object.create(null);
    for (const k of keep) next[k] = map[k];
  }
  createdCache = next;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CREATED_FILE, JSON.stringify(next, null, 2), 'utf8');
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

/** 把入参里所有「可能是目标路径」的字符串摊平成一个数组。
 *
 *  只认路径类字段，绝不递归扫 content / replacement——写文档时正文里出现一句
 *  `rm -rf state` 不该被当成命令。
 *  dsh-ops 的字段比原生工具杂：files[].path、to、pattern[]、script_path、workdir。 */
function targetPathList(toolName, args) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  if (!args || typeof args !== 'object') return out;

  push(args.path);
  push(args.file_path);
  push(args.filePath);
  push(args.target);
  push(args.filename);
  push(args.to);
  push(args.script_path);
  push(args.workdir);

  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === 'string') push(f);
      else if (f && typeof f === 'object') push(f.path);
    }
  }
  if (typeof args.pattern === 'string') push(args.pattern);
  else if (Array.isArray(args.pattern)) for (const p of args.pattern) push(p);
  if (Array.isArray(args.glob)) for (const g of args.glob) push(g);

  // ops_batch 的批量操作：operations[{op,path,to}] 是相对 root 的写法，先拼成绝对路径。
  if (toolName === OPS_BATCH_TOOL) {
    const root = typeof args.root === 'string' ? args.root.trim() : '';
    const join = (p) => {
      if (!root) return p;
      try {
        return path.join(root, p);
      } catch {
        return `${root}\\${p}`;
      }
    };
    for (const op of Array.isArray(args.operations) ? args.operations : []) {
      if (!op || typeof op !== 'object') continue;
      push(join(String(op.path ?? '').trim()));
      push(join(String(op.to ?? '').trim()));
    }
  }
  return out;
}

/** ops_batch 这一调用到底要干什么：null=无副作用（plan / 空操作），否则 'delete' | 'write'。
 *  action=run / resume 才真动手；action=plan 只是建审计计划，不碰文件。 */
function opsBatchKind(args) {
  if (args === null || typeof args !== 'object') return null;
  const action = String(args.action ?? '');
  if (action !== 'run' && action !== 'resume') return null;
  const ops = Array.isArray(args.operations) ? args.operations : [];
  if (ops.length === 0) {
    // operationsRef：操作集在另一个结果的引用里，这里看不到内容。
    // 保守当成删除处理——目标也抽不出来，只能按签名绑 token，照样要用户点一次头。
    return typeof args.operationsRef === 'string' && args.operationsRef.trim() ? 'delete' : null;
  }
  // move 会把源文件挪走，和 remove 一样按删除算。
  return ops.some((o) => o && typeof o === 'object' && ['remove', 'move'].includes(String(o.op ?? '')))
    ? 'delete'
    : 'write';
}

/** 这个 ops 工具调用会造成什么后果：'delete' | 'write' | null（无副作用）。 */
function opsMutationKind(toolName, args) {
  if (OPS_DELETE_TOOLS.has(toolName)) return 'delete';
  if (OPS_WRITE_TOOLS.has(toolName)) return 'write';
  if (toolName === OPS_BATCH_TOOL) return opsBatchKind(args);
  if (typeof toolName === 'string' && toolName.startsWith('ops_') && OPS_MUTATION_NAME_RE.test(toolName)) {
    return /(remove|delete|move|rename|truncate)/.test(toolName) ? 'delete' : 'write';
  }
  return null;
}

/** 这条工具调用有没有碰到状态目录。shell 命令和 read / write / glob / grep 都算。
 *
 *  匹配三层，从严到松：
 *  ① 绝对路径整串（归一化后）
 *  ② 路径片段 `dsh-fileguard/state` 或 `dsh-fileguard\\state`——兜住 `..\..\plugins\dsh-fileguard\state\x`
 *     这类没解析成绝对的写法
 *  ③ 文件名 + 我们的插件名同时出现（`policy.json` 单独出现不算，太常见） */
function touchesState(exec) {
  const needle = normPath(path.resolve(STATE_DIR));
  const fragUnix = 'dsh-fileguard/state';
  const fragWin = 'dsh-fileguard\\state';

  const hitText = (text) => {
    if (typeof text !== 'string' || text === '') return false;
    const n = normPath(text);
    if (n.includes(needle)) return true;
    if (text.includes(fragUnix) || text.includes(fragWin)) return true;
    return false;
  };

  if (hitText(extractCommand(exec?.arguments))) return true;

  const args = exec?.arguments;
  for (const p of targetPathList(exec?.name, args)) {
    if (hitText(p)) return true;
    try {
      if (normPath(path.resolve(p)).includes(needle)) return true;
    } catch {
      // resolve 失败就靠 hitText 那两条
    }
  }
  return false;
}

/** 状态目录的拒绝文案。没有 token 通道——档位本来就不该由模型改。 */
function denyStateDir(toolName) {
  return [
    '【dsh-fileguard 拦截】',
    '',
    `这条 ${toolName} 碰到了守卫自己的状态目录，不放行——读也不行。`,
    '',
    '那里面存的是当前档位和放行凭据。你能看它一眼，这套守卫就等于不存在。',
    '这条对所有档位都一样，换写法重发也没用。',
    '',
    '如果确实要改档位或免审窗口，请用户自己在设置页里改，或者用 /guard-* 命令。',
  ].join('\n');
}

/**
 * 本插件自己的配置入口：谁能写它，谁就能把 devMode / enabled 改成自己想要的，
 * 等于绕过整套守卫。所以对它一律硬拦——不管哪个档位、哪个工具。
 * 想改配置请用户自己在设置页改，或者手工编辑后重启。
 */
function touchesConfigFile(exec, toolName) {
  const args = exec?.arguments;
  const texts = [extractCommand(args) ?? '', ...targetPathList(toolName, args)].join('\n').toLowerCase();
  const hit = () => {
    if (texts.includes('cordis.patch.yml')) return 'cordis.patch.yml';
    // 只认「路径里带 dsh-fileguard 的 package.json」——不能把所有 package.json 都拦了，
    // 那正常开发就没法干活了。
    if (texts.includes('package.json') && texts.includes('dsh-fileguard')) return 'package.json';
    return null;
  };
  if (hit() === null) return null;
  // 读不拦：read / glob / grep 这些只读工具，和 Get-Content / Select-String 这类只读命令
  // 一律放行——配置文件里没有秘密，模型本来就看得见；拦的是「改」。
  if (WRITE_TOOL_RE.test(toolName)) return hit();
  // dsh-ops 的写工具没有命令行，但它明确要写盘——按 write 处理，同样硬拦。
  if (OPS_WRITE_TOOLS.has(toolName) || toolName === OPS_BATCH_TOOL) return hit();
  if (!SHELL_TOOLS.has(toolName)) return null;
  const command = extractCommand(args) ?? '';
  if (!DELETE_RE.test(command) && !WRITE_RE.test(command)) return null;
  return hit();
}

function denyConfigFile(toolName, what) {
  return [
    '【dsh-fileguard 拦截】',
    '',
    `这条 ${toolName} 要改守卫自己的配置（${what}），不放行。`,
    '',
    '开发者模式、开关、档位这些只能由用户在设置页里改。',
    '模型能自己写配置的话，这道守卫就形同虚设——这是设计上刻意堵死的一条。',
    '',
    '如果确实需要改，请让用户在「设置 → 文件守卫」里操作，或者自己编辑后重启 DSH。',
  ].join('\n');
}

// ── 守卫 token ────────────────────────────────────────────────────────────
// 只有用户执行 /guard-gettoken 才看得到，模型拿不到（斜杠命令的输出不进模型上下文）。
// 模型要放行就得把它带回来，等于「用户真的看过这条命令、并且点了头」。
//
// 存在 state/tokens.json。守卫对整个 state 目录的访问一律拦死（见 touchesState），
// 模型读不到，所以放在盘上也安全——放盘的好处是重启后用户手里那张还没作废。
//
// 随候选目标集生成：拦下哪一批，token 就绑哪一批。用掉即废；不设时间上限，
// 用户可能半天后才回来看。同一批目标重新被拦会复用同一个 token。
const TOKEN_LEN = 16; // 够长，别给显卡留爆破的念头
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1，抄错一个就白拦了
const TOKENS_FILE = path.join(STATE_DIR, 'tokens.json');
let tokenCache = null;

function readTokens() {
  if (tokenCache !== null && Date.now() - tokenCache.at < 500) return tokenCache.list;
  let list = [];
  try {
    const doc = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    if (Array.isArray(doc?.tokens)) list = doc.tokens;
  } catch {
    list = [];
  }
  list = list.filter(
    (t) => t !== null && typeof t === 'object' && typeof t.token === 'string' && Array.isArray(t.targets) && t.targets.length > 0,
  );
  tokenCache = { at: Date.now(), list };
  return list;
}

function writeTokens(list) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({ tokens: list }, null, 2), 'utf8');
    tokenCache = { at: Date.now(), list };
    return true;
  } catch (e) {
    log(`TOKENS-WRITE-FAIL ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
const TOKEN_RE = new RegExp(`#\\s*fg[:\\-]([A-Za-z0-9]{${TOKEN_LEN}})\\b`);

function newToken() {
  const taken = new Set(readTokens().map((t) => t.token));
  for (let attempt = 0; attempt < 20; attempt++) {
    let s = '';
    for (let i = 0; i < TOKEN_LEN; i++) s += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
    if (!taken.has(s)) return s;
  }
  return null;
}

/** 拦下时发一个：绑住这批目标，改目标就得重新要。返回 null 表示写盘失败。
 *  targets 传**已经归一化过的键**（路径，或抽不出路径时用的 `cmd:<命令签名>`）。 */
function issueToken(targets) {
  const list0 = [...new Set((targets ?? []).filter((t) => typeof t === 'string' && t.length > 0))];
  if (list0.length === 0) return null;
  const sig = list0.slice().sort().join('\u0000');
  // 同一批目标已经发过就复用。模型每被拦一次就换一串的话，
  // 用户手上刚复制的那串立刻作废，来回拉锯永远过不去。
  const existing = readTokens().find((t) => t.targets.slice().sort().join('\u0000') === sig);
  if (existing !== undefined) return existing.token;
  const token = newToken();
  if (token === null) return null;
  const list = readTokens().filter((t) => t.targets.slice().sort().join('\u0000') !== sig);
  list.push({ token, targets: list0, at: Date.now() });
  while (list.length > 64) list.shift();
  return writeTokens(list) ? token : null;
}

function findToken(token) {
  const key = String(token).toUpperCase();
  return readTokens().find((t) => t.token === key) ?? null;
}

function consumeToken(token) {
  const key = String(token).toUpperCase();
  const list = readTokens().filter((t) => t.token !== key);
  writeTokens(list);
}

/**
 * 标记「用户把这串 token 显示出来看过」。
 *
 * 为什么需要这个：ops_* 工具（dsh-ops 插件那一套）的参数 schema 是 additionalProperties:false，
 * 而且 ctx.tools.guard 只能拒绝、不能改写入参——所以模型**没有地方**把 `# fg:<token>` 抄进去。
 * 对这类工具，「用户执行 /guard-gettoken 亲眼看了一遍」本身就是那道人工确认：
 * 模型自己调不了斜杠命令。只有被看过的 token 才能给 ops 工具放行。
 * 命令行走的是老路子（token 抄在命令末尾），两条通道并存，谁也不影响谁。
 */
function markTokenSeen(token) {
  const key = String(token).toUpperCase();
  const list = readTokens();
  const rec = list.find((t) => t.token === key);
  if (rec === undefined) return false;
  if (rec.seen === true) return true;
  rec.seen = true;
  rec.seenAt = Date.now();
  return writeTokens(list);
}

/** 找一个「用户已经看过」且覆盖面足够宽的 token：targets 必须完全包含 need。
 *  同一批目标可能同时存在多个 token（历史遗留），取最新的那个。 */
function findSeenToken(need) {
  const want = new Set(need);
  const list = readTokens().filter((t) => t.seen === true);
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (need.every((p) => t.targets.includes(p))) return t;
  }
  return null;
}

function extractToken(command) {
  const m = TOKEN_RE.exec(command);
  return m === null ? null : m[1].toUpperCase();
}

function stripToken(command) {
  return command.replace(new RegExp(TOKEN_RE.source, 'g'), ' ');
}

/** 提示里给模型看的目标清单，最多列 8 条，多的收成一行。 */
function listTargets(targets, limit = 8) {
  const shown = targets.slice(0, limit).map((p) => `- ${shorten(p, 120)}`);
  if (targets.length > limit) shown.push(`- …… 还有 ${targets.length - limit} 个`);
  return shown.join('\n');
}

function denyTokenInvalid(command, policy) {
  return [
    '【dsh-fileguard 拦截】',
    '',
    '这个 token 不认：已经用掉了，或者根本不是这里发的。',
    '',
    '让用户在你这次的拦截提示里执行 /guard-gettoken，把他给你的那串带上重发：',
    '  Remove-Item ... # fg:XXXXXXXXXXXXXXXX',
    policyFooter(policy),
  ].join('\n');
}

function denyTokenScope(command, missing, allowed, policy) {
  return [
    '【dsh-fileguard 拦截】',
    '',
    `这个 token 只覆盖 ${allowed} 个目标，这条命令还多出 ${missing.length} 个没授权：`,
    listTargets(missing),
    '',
    '超出授权的部分不能跟着一起动。要么让用户再执行一次 /guard-gettoken 拿新 token（新 token 会覆盖这一次的整批），要么把多出来的去掉重发。',
    policyFooter(policy),
  ].join('\n');
}

function check(exec, config) {
  const toolName = exec?.name;
  if (typeof toolName !== 'string') return undefined;

  // 开发者模式：放行守卫自己的东西（state 目录、配置文件）和普通删改，
  // 但**盘根和系统目录依然硬拦**——那两条是真正的红线，跟调试方不方便无关。
  // 放行的那部分只记日志，设置页里有红字提醒，用完记得关。
  if (config?.devMode === true) {
    const devPolicy = resolvePolicy(config);
    const rawDev = extractCommand(exec?.arguments);
    const cmdDev =
      rawDev === null || rawDev === undefined
        ? ''
        : extractToken(rawDev) === null
          ? rawDev
          : stripToken(rawDev);
    const toolPath = toolWritePath(exec?.arguments);
    const devIsDelete = cmdDev !== '' && DELETE_RE.test(cmdDev);
    // ops 工具（ops_remove / ops_batch …）没有命令行，路径在 path / to / operations[] 里。
    const devPaths = targetPathList(toolName, exec?.arguments);
    const devOpsDelete = opsMutationKind(toolName, exec?.arguments) === 'delete';

    if (cmdDev !== '') {
      const rootDev = devIsDelete ? driveRootHit(extractPaths(cmdDev)) : undefined;
      if (rootDev !== undefined) {
        log(`DEV-DENY(protected:root:${rootDev}) tool=${toolName}`);
        return denyProtected(cmdDev, rootDev, devPolicy, true);
      }
      const hit = protectedHit(cmdDev, config?.protectedDirs);
      if (hit !== undefined) {
        log(`DEV-DENY(protected:sys:${hit}) tool=${toolName}`);
        return denyProtected(cmdDev, hit, devPolicy, devIsDelete);
      }
    } else if (devPaths.length > 0) {
      // write / edit 这类工具没有命令行，拿路径直接查——写 C:\Windows 也得拦。
      const rootDev = devOpsDelete ? driveRootHit(devPaths) : undefined;
      if (rootDev !== undefined) {
        log(`DEV-DENY(protected:root:${rootDev}) tool=${toolName}`);
        return denyProtected(devPaths.join(' ; '), rootDev, devPolicy, true);
      }
      const hit = protectedHitPaths(devPaths, config?.protectedDirs);
      if (hit !== undefined) {
        log(`DEV-DENY(protected:sys:${hit}) tool=${toolName}`);
        return denyProtected(devPaths.join(' ; '), hit, devPolicy, devOpsDelete);
      }
    }

    log(`DEV-PASS tool=${toolName} cmd=${shorten(cmdDev !== '' ? cmdDev : (toolPath ?? devPaths[0] ?? ''), 160)}`);
    return undefined;
  }

  // 0) 状态目录：不管哪个工具、读还是写，一律不放行。
  //    这里存着档位和放行凭据。放在最前面——read / write / glob / grep 也归它管，
  //    不能像别的写操作那样直接 return undefined 放过去。
  if (touchesState(exec)) {
    log(`DENY(state-dir) tool=${toolName}`);
    return denyStateDir(toolName);
  }

  // 0b) 守卫自己的配置文件（cordis.patch.yml / 本插件 package.json）：
  //     能改它就等于能给自己开开发者模式，所以一律硬拦。
  //     注意只拦「写」：读一眼配置不算破防（里面没有 token），把 read / glob / grep
  //     也拦掉只会让人连自己装了什么都不知道，而且我调代码时天天要读它。
  //     注意只拦「写」：读一眼配置不算破防（里面没有 token）。
  const cfgHit = touchesConfigFile(exec, toolName);
  if (cfgHit !== null) {
    log(`DENY(config-file:${cfgHit}) tool=${toolName}`);
    return denyConfigFile(toolName, cfgHit);
  }

  // 0c) dsh-ops 工具集（ops_remove / ops_write_file / ops_batch …）。
  //     名字不在 SHELL_TOOLS 里、参数也没有命令行，走下面那条「非 shell 放行」
  //     会整组漏过去——那正是最要命的一条后门：ops_batch 一句话就能批量删文件。
  //     这里的判定不看命令文本，看的是「这次调用会造成什么后果」：
  //       ops_remove / ops_move / ops_batch(含 remove|move)  → delete
  //       ops_write_file / ops_edit_file / ops_replace / ops_copy → write
  //     dryRun=true 只观察不落盘，直接放行，也不记账。
  const opsArgs = exec?.arguments;
  const opsKind = opsMutationKind(toolName, opsArgs);
  if (opsKind !== null) {
    if (config?.enabled === false) return undefined;
    if (opsArgs?.dryRun === true) {
      log(`ALLOW(ops-dryrun,${opsKind}) tool=${toolName}`);
      return undefined;
    }

    const opsPaths = targetPathList(toolName, opsArgs);
    const opsPolicy = resolvePolicy(config);

    // 只读档：任何会落盘的动作都不放行，和命令行那边同一套口径。
    if (opsPolicy === 'readonly' || config?.readOnlyMode === true) {
      log(`DENY(readonly:${opsKind}) tool=${toolName}`);
      return denyReadOnly(opsPaths.length > 0 ? opsPaths.join(' ; ') : toolName, toolName, opsPolicy);
    }

    // 盘根只在删除时判——和命令行那边一致。
    const opsRoot = opsKind === 'delete' ? driveRootHit(opsPaths) : undefined;
    if (opsRoot) {
      log(`DENY(protected:root:${opsRoot},${opsKind}) tool=${toolName}`);
      return denyProtected(opsPaths.join(' ; ') || toolName, opsRoot, opsPolicy, true);
    }
    const opsHit = protectedHitPaths(opsPaths, config?.protectedDirs);
    if (opsHit && (opsPolicy === 'high' || opsKind === 'delete')) {
      log(`DENY(protected:sys:${opsHit},${opsKind}) tool=${toolName}`);
      return denyProtected(opsPaths.join(' ; ') || toolName, opsHit, opsPolicy, opsKind === 'delete');
    }

    // 写盘先记账（dryRun 上面已经放行，不会走到这儿）。
    if (opsKind === 'write') markCreated(opsPaths, toolName);

    // AI 自己建的临时文件：low / default 档免审，和命令行那边一致。
    const opsTempH = tempHours(config);
    if (opsKind === 'delete' && (opsPolicy === 'low' || opsPolicy === 'default') && opsTempH > 0) {
      const ledger = allAiCreated(opsPaths, opsTempH);
      if (ledger.ok) {
        log(`ALLOW(ai-created:${opsPaths.length},${opsTempH}h) tool=${toolName}`);
        return undefined;
      }
    }

    // 档位：low 全放、default 只拦删、high 都拦。
    if (!opsHit) {
      if (opsPolicy === 'low') return undefined;
      if (opsKind === 'write' && opsPolicy !== 'high') return undefined;
    }

    // 目标集：路径键；一个路径都抽不出来（ops_replace 不写 path、ops_batch 用引用）
    // 时按「工具名 + 入参签名」兜底——否则没有可绑的东西，token 发不出来，守卫就被绕过。
    let opsNeed = [...new Set(opsPaths.map((p) => ledgerKey(p)).filter((p) => p.length > 0))];
    if (opsNeed.length === 0) {
      const sig = `${opsKind}\u0000${toolName}\u0000${JSON.stringify(opsArgs ?? {})}`.toLowerCase();
      opsNeed = [`cmd:${sig}`];
    }

    // ops 工具没法把 token 写进参数（schema 是 additionalProperties:false，guard 只能拒绝
    // 不能改参数），所以这里只认「用户执行过 /guard-gettoken」的 token——
    // 那一步模型自己做不到，等于用户亲手点了头。命令行走 token 抄进命令那条老路。
    const opsSeen = findSeenToken(opsNeed);
    if (opsSeen !== null) {
      consumeToken(opsSeen.token);
      log(`ALLOW(ops-token,${opsKind},${opsNeed.length}) tool=${toolName}`);
      return undefined;
    }

    const opsIssued = issueToken(opsNeed);
    const opsWhy = opsHit ? `first-protected:${opsHit}` : 'first';
    log(`DENY(${opsWhy},${opsKind},${opsIssued === null ? 'token-fail' : 'token-issued'}) tool=${toolName}`);
    return denyOpsFirstTime(toolName, opsKind, opsHit || undefined, opsPolicy, opsPaths, opsIssued);
  }

  // 不是 shell 的工具（write / edit / …）：不拦——用户明确要求这些不受管辖——
  // 但如果它在写文件就记一笔账，以后删它建的临时文件时就不用再问一遍。
  if (!SHELL_TOOLS.has(toolName)) {
    if (config?.enabled !== false) {
      const p = toolWritePath(exec?.arguments);
      if (p) markCreated([p], toolName);
    }
    return undefined;
  }

  const raw = extractCommand(exec?.arguments);
  if (!raw) return undefined;

  // 总开关关掉时什么都不拦（对模型完全无感）。
  if (config?.enabled === false) return undefined;

  // token 是模型从用户那里拿来的授权凭证，先摘出来，后面的路径解析不能把它当文件。
  const token = extractToken(raw);
  const command = token === null ? raw : stripToken(raw);

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
  //    盘根：只在**删除**时判，所有档位都不放行——删整块盘没有「问一次」的说法。
  //    往盘根里写文件（Copy-Item 到 E:\、New-Item E:\x）不算，那不会毁掉整块盘。
  //    这条很关键：命令里别处出现了 'E:\' 这种字符串字面量不该被当成删盘根。
  //    系统目录里的删除：所有档位都不放行。删 Windows / Program Files 底下的东西
  //    没有一个档位是安全的，低守卫也不例外（低守卫的定义就是只硬拦这个）。
  //    系统目录里的写入：high 档不放行；low / default 走「拦一次 + token」，
  //    因为确实有人需要改系统目录里的配置——但 token 同样得用户亲手给。
  const rootHit = isDelete ? driveRootHit(extractPaths(command)) : undefined;
  if (rootHit) {
    log(`DENY(protected:root:${rootHit},${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
    return denyProtected(command, rootHit, policy, true);
  }
  const hit = protectedHit(command, config?.protectedDirs);
  if (hit) {
    if (policy === 'high' || isDelete) {
      log(`DENY(protected:sys:${hit},${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
      return denyProtected(command, hit, policy, isDelete);
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

  // 3) token：用户在对话框里把他从 /guard-gettoken 拿到的串递给模型，模型带着重发。
  //    目标必须全在 token 绑定的集合里——多一个就得重新要一个，增量就是这么处理的。
  const normed = paths.map((p) => normPath(p));
  const normSet = new Set(normed.filter(Boolean));
  const now = Date.now();
  // 目标集：能抽到路径就按路径；抽不出路径的（`git clean -fdx`、`robocopy /MIR` 这类）
  // 按命令原文签名——否则没有可绑的东西，token 发不出来，守卫也能被一句话绕过去。
  const cmdSig = `${kind}\u0000${command.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  let need = [...new Set(paths.map((p) => ledgerKey(p)).filter((p) => p.length > 0))];
  if (need.length === 0) need = [`cmd:${cmdSig}`];

  if (token !== null) {
    const rec = findToken(token);
    if (rec === null) {
      log(`DENY(token-invalid,${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
      return denyTokenInvalid(command, policy);
    }
    const missing = need.filter((p) => !rec.targets.includes(p));
    if (missing.length === 0) {
      consumeToken(token);
      log(`ALLOW(token,${kind},${need.length}) tool=${toolName} cmd=${shorten(command, 200)}`);
      return undefined;
    }
    log(`DENY(token-scope:${missing.length},${kind}) tool=${toolName} cmd=${shorten(command, 200)}`);
    return denyTokenScope(command, missing, rec.targets.length, policy);
  }

  // 4) 档位决定普通删除 / 写入要不要拦：
  //    low     —— 普通删除、普通写入都放行（盘根和系统目录已经在上面拦掉了）
  //    default —— 拦删除；写入放行
  //    high    —— 删除和写入都拦（read / write / edit 工具本来就不在管辖范围）
  if (!hit) {
    if (policy === 'low') return undefined;
    if (isWrite && policy !== 'high') return undefined;
  }

  // 5) 拦下：发一个绑定这批目标的 token。授权的凭据从此不在模型手里——
  //    他要想放行，只能让用户去 /guard-gettoken 抄一串回来。
  //    need 里可能是路径，也可能是抽不出路径时的 `cmd:<签名>`，两种都能绑。
  const issued = issueToken(need);

  const why = hit ? `first-protected:${hit}` : 'first';
  log(`DENY(${why},${kind},${issued === null ? 'token-fail' : 'token-issued'}) tool=${toolName} cmd=${shorten(command, 200)}`);
  return denyFirstTime(command, kind, hit || undefined, policy, paths, issued);
}

/** 一条斜杠命令对应一档，名字里就带档位——聊天框里打 /guard 能把四条一起列出来。 */
function policyCommandDefinition(meta) {
  return {
    name: meta.command,
    description: `文件守卫策略切到「${meta.label}」：${meta.summary}。写进插件配置，一两秒后生效。`,
    handler() {
      if (!patchConfig({ policy: meta.key })) {
        return {
          kind: 'error',
          text: '写配置失败（找不到本插件的配置项或 configEditor 不可用），档位没变。',
        };
      }
      log(`POLICY=${meta.key}`);
      return {
        kind: 'success',
        text: `文件守卫策略 = ${meta.label}（${meta.key}）：${meta.summary}\n已写入配置，插件重载后生效（通常一两秒）。`,
      };
    },
  };
}

/**
 * 从斜杠命令的 invocation 里取参数。
 * DSH 的 CommandInvocation 实际字段是 `rawInput`（命令名之后的那段原文），
 * 这里把它排在最前，其余字段名留作兼容——不同版本的命令平面叫法不一样。
 */
function invocationArg(invocation) {
  if (invocation === null || typeof invocation !== 'object') return '';
  for (const key of ['rawInput', 'args', 'rest', 'text', 'raw', 'input', 'argument', 'params']) {
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
    // 必须声明 input，否则带参数的输入会被当成普通消息发给模型，根本不进 handler。
    input: { hint: '小时数，例如 4；留空则循环切换' },
    handler(invocation) {
      const raw = invocationArg(invocation);
      const cur = tempHours(pluginConfig);
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
      if (!patchConfig({ tempHours: next })) {
        return {
          kind: 'error',
          text: '写配置失败（找不到本插件的配置项或 configEditor 不可用），窗口没变。',
        };
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

/**
 * /guard-gettoken —— 把当前待放行批次的 token 显示给用户。
 *
 * 模型看不到这个输出（斜杠命令不进模型上下文），所以 token 只能由用户亲手递给它。
 * 输出刻意只留 token 本身：多余的字会蹭进选中范围，复制不全就白忙一趟。
 */
/** /guard-dev [on|off] —— 切开发者模式。不带参数就取反。 */
function devCommandDefinition() {
  return {
    name: 'guard-dev',
    description:
      '开发者模式：放行普通删改、state/ 目录、守卫自己的配置，只记日志。盘根和系统目录依然硬拦。不带参数则取反。',
    input: { hint: 'on / off，留空取反' },
    handler(invocation) {
      const raw = invocationArg(invocation).toLowerCase();
      const cur = pluginConfig?.devMode === true;
      let next;
      if (raw === 'on' || raw === '1' || raw === 'true') next = true;
      else if (raw === 'off' || raw === '0' || raw === 'false') next = false;
      else if (raw === '') next = !cur;
      else return { kind: 'error', text: `看不懂「${raw}」。给 on 或 off，或者不带参数取反。` };
      if (!patchConfig({ devMode: next })) {
        return {
          kind: 'error',
          text: '写配置失败（找不到本插件的配置项或 configEditor 不可用），没变。',
        };
      }
      log(`DEV_MODE=${next}`);
      return {
        kind: 'success',
        text: next
          ? '开发者模式已开启：普通删改、state/ 目录、守卫自己的配置都放行，只记日志。盘根和系统目录依然拦着。调试完记得 /guard-dev off。'
          : '开发者模式已关闭：守卫恢复正常拦截。',
      };
    },
  };
}

function getTokenCommandDefinition() {
  return {
    name: 'guard-gettoken',
    description:
      '取出当前被拦下那一批的守卫 token。执行后把 token 打给模型，它才能带 # fg:<token> 重发通过。token 只对那批目标有效，用掉即废。',
    handler() {
      const list = readTokens();
      if (list.length === 0) {
        return { kind: 'error', text: '当前没有被拦下的批次。等模型被拦一次之后再来取。' };
      }
      const latest = list[list.length - 1];
      // 标记「用户看过了」：ops_* 工具没法在参数里带 token（schema 封闭、guard 不能改参数），
      // 所以它们只认「已被用户看过」的 token。命令行走 token 抄回命令那条老路，不受影响。
      markTokenSeen(latest.token);
      return { kind: 'success', text: `已获取本次守卫token:${latest.token}` };
    },
  };
}

export function apply(ctx, config) {
  pluginCtx = ctx; // 斜杠命令改配置要靠它（handler 拿不到 ctx）
  pluginConfig = config; // policyFooter 读 hintResetAt
  log(`apply; tools=${typeof ctx?.tools} enabled=${config?.enabled !== false} policy=${resolvePolicy(config)} devMode=${config?.devMode === true}`);
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
      try {
        ctx.effect(() => commands.register(getTokenCommandDefinition()));
      } catch (e) {
        log(`cmd guard-gettoken FAIL ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        ctx.effect(() => commands.register(devCommandDefinition()));
      } catch (e) {
        log(`cmd guard-dev FAIL ${e instanceof Error ? e.message : String(e)}`);
      }
      log(
        `commands: ${POLICY_META.map((m) => '/' + m.command).join(' ')} /guard-temp /guard-gettoken /guard-dev`,
      );
      return;
    }
    if (attempt < 20) setTimeout(() => tryRegister(attempt + 1), 1000);
    else log('commands 服务 20s 内未就绪，/guard-* 未注册（守卫本身不受影响）');
  };
  tryRegister(0);
}
