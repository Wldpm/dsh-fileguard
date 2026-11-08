# dsh-fileguard

**语言 / Languages：** [简体中文](#dsh-fileguard) · [English](#english) · [Русский](#русский) · [日本語](#日本語)

给 **DeepSeek Harness** 用的文件守卫插件。

在全权模式下，模型动手删东西、改东西之前先拦一道，逼它停下来把「动的是什么、有什么用、删改了会怎样」用自然语言讲清楚，再由你用token（相当于钥匙）决定放不放行。模型自己干活时产生的临时文件走旁路台账，窗口期内免审，不打扰你。

它解决的具体问题：DSH 开 `workspace-write` 之后，真正拦危险操作的是系统提权确认框，而那个框里全是英文路径和一串 `$ % #` 符号，扫一眼判断不了点下去会发生什么，手一快就同意了。
而即使是打开全权模式后，这个插件可以强制模型先调研文件内容，给一份能看懂的，按风险分层次的自然语言说明，而决定权交还给你。（哪怕这会多用一点点token余额，但这也理应是值得的...）

---

## 一条一条说清楚

### 硬限制：这四类永远不放行

| 类别 | 说明 |
|---|---|
| **盘根的删除** | `C:\` `D:\` `E:\`、插上来的 U 盘盘根……任何盘的根目录。删它等于清空整块盘。**只在删除时生效**——往盘根里复制文件、列举盘根都不拦。 |
| **系统目录里的删除** | `C:\Windows`、`Program Files`、`ProgramData`、`$Recycle.Bin`、`Recovery` 等。**所有档位、任何模式（含开发者模式）都硬拦。** |
| **带通配符的删除 / 写入** | `Remove-Item *.log` 这类。命中范围在动手前没法逐项核对。**只读操作不受限**，`Get-ChildItem *.txt` 照常。 |
| **改插件自己的配置** | 两样都拦：**配置项的值**（开发者模式、档位、开关、免审窗口）只能由你在设置页或斜杠命令里改；**配置文件本身**（profile 的 `cordis.patch.yml`、本插件的 `package.json`）模型写入会被拦。**读不受限**，它照样能看。 |

在「动文件」这件事上，原生工具、`pwsh` / `bash` 命令和 dsh-ops 插件注册的 `ops_*` 工具一视同仁：`ops_remove` 和 `Remove-Item` 撞的是同一套规则，`ops_read_files` 想读 `state/` 一样会被拦死。

### 四档策略

| 档位 | 命令 | 删除 | 写入 / 改盘 | 盘根 | 系统目录·删 | 系统目录·改 |
|---|---|---|---|---|---|---|
| 纯白名单 | `/guard-readonly` | 拦死 | 拦死 | 拦死 | 拦死 | 拦死 |
| 高拦截 | `/guard-high` | 拦一次 | 拦一次 | 拦死 | 拦死 | 拦死 |
| 默认 | `/guard-default` | 拦一次 | 放行 | 拦死 | 拦死 | 拦一次 |
| 低守卫 | `/guard-low` | 放行 | 放行 | 拦死 | 拦死 | 拦一次 |

- **拦死** = 重发多少次都不放行，提示里明确写「不要再试」。
- **拦一次** = 插件挡下，生成一串**一次性 token**。模型必须从你手里拿到 token，带着它重发才放行。token 只覆盖这次拦下的那批目标，用掉即废。
- **放行** = 直接执行，模型看不到任何提示。

### 拦一次之后会发生什么

模型会收到一段提示词，它将会被要求：

1. **说明**——讲清要动的是什么、有什么用、删掉之后会怎样；确实没影响就直说「可以放心清理」。
2. **请你放行**——你会在输入框里执行 `/guard-gettoken`，拿到一串 16 位 token，把这串打给它。
3. **带着 token 重发**——在命令末尾加注释即可：`Remove-Item 'D:\work\old.log' # fg:<那串 token>`。注释不影响执行。`ops_*` 系列没有命令行，把同样的调用原样重发一遍就行，参数一个都不用改。
4. 手上还有别的活可以先干完，最后统一汇报，不用一条一条卡着问。

**为什么 token 靠得住**：斜杠命令的输出只进日志，模型上下文里看不到——你执行 `/guard-gettoken` 拿到的东西，它没法自己生成、也没法偷看。

### AI 自己写的临时文件：在一定时间内免审

模型干活会造一堆一次性的东西（探测脚本、截图、日志等）。删这些还要问一次纯属互相折磨。

插件维护一份旁路台账，记下模型写过哪些路径：

- `write` / `edit` 等工具写文件时记进去；
- `Set-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Move-Item` 等命令执行时，把命令里出现的路径记进去；
- 之后删这些路径，在 **低守卫 / 默认** 档下直接放行。

**只认台账上登记过的路径**——你自己新建的文件不在账上，照旧要确认。也正因如此它不碰文件内容、不看创建时间。

四条限制：

1. **目录不放行**：刚 clone 的仓库、刚解压的包也会被记进台账，但删错的代价大，一律走确认。
2. **通配符不放行**。
3. **高拦截 / 纯白名单档不生效**。
4. **窗口有限**：默认 8 小时，过期不再免审；台账最多 5000 条，超了按时间淘汰最旧的。

窗口用 `/guard-temp` 调：

| 命令 | 效果 |
|---|---|
| `/guard-temp` | 循环切换：1 → 4 → 8 → 24 → 72 → 关 |
| `/guard-temp 12` | 直接设成 12 小时 |
| `/guard-temp 0` | 关掉这个机制 |

### 状态目录

插件把需要保密的东西放在插件目录下的 `state/`：

| 文件 | 内容 |
|---|---|
| `tokens.json` | 待放行的 token 及它授权的目标 |
| `ai-created.json` | 旁路台账 |

**守卫对这个目录的任何访问都拦死，读取也算。** 不管哪一档、用哪个工具，全部拒绝。理由：这套守卫的全部权威都在这两个文件里，模型能看一眼就等于没有守卫。

档位、窗口、开关**不在** `state/` 里——它们存在插件配置（profile 的 `cordis.patch.yml` 那一层），所以设置页能改。那份**配置文件本身同样受保护**：模型想用 `Set-Content` / `edit` 直接改 `cordis.patch.yml` 或本插件的 `package.json`，一样会被拦下（读不拦）。两条路都堵死，它能动的只有聊天框里的命令——而命令改的值，最终还是你点的。

**你自己怎么改**：守卫拦的是模型，不拦你。设置页点一下最省事；直接编辑配置文件、或者用 `/guard-*` 命令也行。

### 已知边界

**这是软约束，不是安全边界。** 它挡不住一个执意要删东西的模型：

- 换个写法的删除看不见：`robocopy /MIR` 覆盖、`run_code` 里现拼的 JS，以及 `getattr(os,'remove')` 这种绕开字面量的写法。
- 内联脚本里的删除能认一部分：`python -c`、`node -e`、`pwsh -Command`、`bash -c` 里出现 `os.remove` / `shutil.rmtree` / `fs.rmSync` / `[IO.File]::Delete` 会按删除处理；但别名、字符串拼接、变量间接调用照样绕得过去。
- `run_code` 里现拼 JS 删文件不经过任何命令解析，不在管辖范围；`write` / `edit` 只查状态目录和配置文件，写别处不拦。
- ops 工具靠「工具名 + 参数结构」识别。dsh-ops 改名或改参数时要同步更新守卫——名字里带删除/写入字样的未知 ops 工具已经兜底拦了，改成完全不相干的名字则兜不住。
- 状态目录的锁靠「看不见」而不是权限——模型换个不把路径写出来的写法（运行时拼字符串、`node -e` 里现拼）就能绕过。

能做的是把门槛抬高，让你有时间踩刹车；真正物理隔离得靠操作系统 ACL，或者相对麻烦点的 `workspace-write` 。

---

## 安装

**前提**：插件目录必须能解析到 `@deepseek-ai/schemastery`（宿主提供的依赖）。用 `link:` 装进 profile 时，如果插件不在 profile 的 `node_modules` 搜索路径下，就要手动补一个 junction，见下面的「依赖坑」。

### 方式一：从本地目录装（最稳）

```powershell
dsh plugin --profile <profile名> add <本仓库绝对路径>
```

### 方式二：手动挂载

1. 把仓库放到任意位置，比如 `~/.dsh/plugins/dsh-fileguard`。
2. 在目标 profile 的 `package.json` 里加两处：

   ```jsonc
   {
     "dependencies": {
       "dsh-fileguard": "link:<仓库绝对路径>"
     },
     "dsh": {
       "profile": {
         "bundles": [ ..., "dsh-fileguard" ]      // ← 必须登记，否则不会加载
       }
     }
   }
   ```

3. 在 profile 目录跑 `pnpm install`。
4. 重启 DSH。

### 依赖坑（必读）

如果插件目录下没有 `node_modules/@deepseek-ai`，模块加载阶段就会报：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

`link:` 只解决「包能不能被找到」，包内部的 import 会按真实路径往上找 `node_modules`。补一个 junction 即可：

```powershell
New-Item -ItemType Junction `
  -Path "<插件目录>\node_modules\@deepseek-ai" `
  -Target "<profile目录>\node_modules\@deepseek-ai"
```

### 挂载方式：用 bundles，不要用 `- insert:`

在 profile 的 `cordis.patch.yml` 里用 `- insert:` 硬塞插件会让 loader 把它记成 `include:dsh-fileguard`，这种 entry **`configEditor` 一律拒绝写入**，设置页和斜杠命令都会报 `Configuration for "dsh-fileguard" is overridden by a home patch`。

正确做法就是把包名登记进 `dsh.profile.bundles`（见上面方式二第 2 步），`cordis.patch.yml` 里最多留一个开关：

```yaml
- id: dsh-fileguard
  disabled: false
```

### 验证装好了没

重启后看日志（默认 `%TEMP%\dsh-fileguard.log`），应该有两行：

```
apply; tools=object enabled=true policy=default
commands: /guard-low /guard-default /guard-high /guard-readonly /guard-temp /guard-gettoken /guard-cleantoken /guard-dev
```

只有第一行 = 插件加载了但命令没注册（`commands` 服务晚于 20 秒就绪）；两行都没有 = 插件没加载。

设置页左侧应该出现「**文件守卫**」一栏。

---

## 让 Agent 帮你装

把下面这段直接发给 Agent：

> 帮我装 dsh-fileguard 插件：
> 1. 把仓库放到 `~/.dsh/plugins/dsh-fileguard`。
> 2. 在 profile 的 `package.json` 里加 `"dsh-fileguard": "link:<路径>"` 到 dependencies，并把 `"dsh-fileguard"` 加进 `dsh.profile.bundles` 末尾。
> 3. 如果插件目录下没有 `node_modules/@deepseek-ai`，建一个 junction 指向 profile 的同一个目录。
> 4. 在 profile 目录跑 `pnpm install`。
> 5. 不要用 `cordis.patch.yml` 的 `- insert:` 挂载，那会让配置写不进去。
> 6. 让我重启 DSH，然后检查日志里有没有 `apply;` 和 `commands:` 两行。
>
> **装完请告诉我：**
> - 设置页左侧多了一栏「文件守卫」，里面能改开关、档位、临时文件免审窗口、提示词重置、开发者模式。
> - 平时命令被拦时，我要在聊天框打 `/guard-gettoken` 拿 token 给它。
> - 档位可以用 `/guard-low` `/guard-default` `/guard-high` `/guard-readonly` 随时切，也可以直接点设置页。
> - 调试时可以 `/guard-dev on` 临时放开（盘根和系统目录仍然拦着），用完记得 `/guard-dev off`。
> - 这是软约束，不是安全边界，别指望它挡住执意要删东西的模型。

---

## 配置项

全部可以在**设置页 → 文件守卫**里改，也可以写进 profile 的 `cordis.patch.yml`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关掉后所有命令直接放行，等于没装 |
| `policy` | string | `"default"` | 守卫强度：`low` / `default` / `high` / `readonly` |
| `tempHours` | number | `8` | AI 临时文件免审窗口（小时）。`0` = 关掉这个机制，上限 720 |
| `hintResetAt` | number | `0` | 提示词初始化：改成新时间戳后，「只出现一次」的说明会重新出现 |
| `devMode` | boolean | `false` | 开发者模式：放行普通删改、`state/` 目录、插件自己的配置文件（这样也许能更方便地对Agent许愿帮你定制化这个插件，但这也会变得很危险），只记日志。**盘根和系统目录仍然硬拦** |
| `protectedDirs` | string[] | 见下 | 额外保护的目录，含其下全部内容 |
| `readOnlyMode` | boolean | `false` | 等同 `policy: "readonly"`，保留兼容旧配置 |

`protectedDirs` 默认值由系统环境变量推导，通常包含：

```
C:\Windows  C:\Program Files  C:\Program Files (x86)  C:\ProgramData
C:\Windows.old  C:\$Recycle.Bin  C:\System Volume Information
C:\Recovery  C:\Boot  C:\PerfLogs
```

盘根不在这张表里——它由正则单独判定，所有盘符都拦。

## 命令

| 命令 | 作用 |
|---|---|
| `/guard-low` `/guard-default` `/guard-high` `/guard-readonly` | 切换档位 |
| `/guard-temp [小时]` | 调整临时文件免审窗口；不带参数循环切换，`0` 关掉 |
| `/guard-gettoken` | 取出待放行批次的 token；被拦了多批就一次全列出来，每批一个（**这是给用户的，模型拿不到输出**） |
| `/guard-cleantoken` | 一次清空所有待放行 token，全部立刻失效（不确定那批是想放行什么时用） |
| `/guard-dev [on\|off]` | 切开发者模式；不带参数取反 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FILEGUARD_LOG` | `%TEMP%\dsh-fileguard.log` | 日志路径 |
| `DSH_FILEGUARD_STATE` | `<插件目录>\state` | 状态目录，主要为测试用 |

---

## 技术细节

**拦截入口**：`ctx.tools.guard((exec) => string | undefined)`。返回字符串即拒绝并把该字符串作为提示词交给模型，返回 `undefined` 放行。`exec.name` 是工具名，`exec.arguments` 是冻结的参数快照。

**判定顺序**（`check()`）：

```
enabled=false        → 放行
devMode=true         → 只放行普通操作，仍先查盘根/系统目录
state/ 或配置文件    → 拦死（写入类工具才查配置文件，读放行）
ops_* 变更工具       → dryRun 放行；否则进入下面同一套判定
非 shell 工具        → 放行（write/edit 只在 state/配置检查里被查目标路径）
抽通配符             → 拦死
盘根（仅删除）       → 拦死
protectedHit         → 系统目录
  ├ high + 系统目录  → 拦死
  └ 系统目录删除     → 所有档位拦死
readonly 档          → 只读白名单以外全拦
low 档               → 删除放行
high 档              → 删除和写入都拦
其余                 → token 校验 → 拦一次并发 token
```

**token**：16 位，字母表去掉 `I O 0 1` 避免抄错；存在 `state/tokens.json`，同一批目标复用同一个 token，用掉即删。识别正则 `#\s*fg[:\-]([A-Za-z0-9]{16})\b`，匹配后从命令里剥掉再解析路径，避免 token 被当成文件名。

**路径归一化**：全小写、反斜杠转正斜杠、去尾斜杠，盘根用 `/^[a-z]:\\$/` 精确判定（不能用 `startsWith('c:\\')`，那会把整块盘锁死）。

**抽不出路径的命令**（`git clean -fdx`、`robocopy /MIR`）按命令原文签名 `cmd:<kind>|<归一化命令>` 绑 token，不给「重发即放行」的退路。`ops_batch` 用 `operationsRef` 又没有内联 `operations` 时同理——看不到要动哪些文件，一律按这份签名卡住。

**dsh-ops 工具集**：`ops_remove`、`ops_write_file`、`ops_edit_file`、`ops_replace`、`ops_copy`、`ops_move`、`ops_batch`（`action` 为 `run` / `resume` 时）与 shell 命令同权处理——档位、盘根、系统目录、`state/`、配置文件一律照旧生效；`dryRun: true`、`action=plan` 和只读 ops 工具（`ops_stat`、`ops_grep`、`ops_result` 等）不受影响。路径从 `path` / `to` / `files[].path` / `pattern` / `glob[]` / `script_path` / `workdir` 取，`ops_batch` 还会把 `operations[].path`、`operations[].to` 按 `root` 拼成绝对路径。`ops_` 前缀硬编码在 `dsh-ops/lib/policy.js`，改不了；名字里带 `remove/move/rename/write/edit/replace/copy/truncate/batch` 的未知 ops 工具也按变更处理，插件升级后不会自动多出后门。

**ops 工具怎么带 token**：它们没有命令行，参数 schema 又是封闭的（`additionalProperties: false`），塞不进 `# fg:<token>`。所以 `/guard-gettoken` 在你看到 token 的那一刻给它打上 `seen` 标记——只有被你亲眼看过的 token 才允许从 ops 通道放行；模型自己去 `state/tokens.json` 翻是拿不到的，那个目录对它拦死。你让它把同样的调用原样重发一遍即可，一个参数都不用改。被拦了好几批时，`/guard-gettoken` 会把每一批都列出来、各配一个 token，互不覆盖；哪批被用掉哪批才失效，剩下的照旧留在那儿。

**路径写法**：`C:\`、`C:/`、`\\server\` 和 git-bash 的 `/c/Users/...` 都认。MSYS 写法会先归一成 `c:/Users/...` 再和 token 里记的路径比对，所以同一份文件换个写法重发也能命中——不会退化成一串对不上的 `cmd:` 签名。

**旁路台账**：只记路径不碰内容。`write`/`edit` 从 `file_path`/`filePath`/`path`/`target`/`filename` 取；shell 命令从 `extractPaths()` 取；ops 变更工具从 `targetPathList()` 取。目录不收。

**状态目录保护**：路径匹配三层——绝对路径整串、`dsh-fileguard/state` 片段（挡未归一化的相对路径）、`glob` 的 `pattern`。原生工具、shell 命令、ops 工具走的是同一份路径抽取。

**配置文件保护**（`touchesConfigFile()`）：只对写入类调用生效（shell 工具，或 `write` / `edit` / `str_replace_editor` / `apply_patch` / `multi_edit`），读放行。命中条件——命令或目标路径里出现 `cordis.patch.yml`；或同时出现 `package.json` 与 `dsh-fileguard`（不能拦所有 `package.json`，那样正常开发没法干活）。

**配置写入**：命令 handler 必须同步返回，而 `configEditor.edit` 是 async，所以 fire-and-forget，改完由 loader 重载插件生效（通常一两秒）。

**前端**：`lib/client.js` 走 ModuleLoader 包装，`require('react')` 外部化（宿主单例，打进 bundle 会双 React 崩 slots），通过 `ctx.slots.inject('settings.section', ...)` 注册 `id: 'dsh-fileguard'` / `order: 45` / `label: '文件守卫'`，读写走 `configForms.get('dsh-fileguard')` 拿到的 scope。

## 许可

MIT，见 [LICENSE](./LICENSE)。

---

# English

A file-guard plugin for **DeepSeek Harness**.

In full-permission mode, it steps in before the model deletes or modifies anything, forcing it to stop and explain in plain language "what this is, what it's used for, and what happens if it's deleted or changed" — then you decide whether to let it through with a token (essentially a key). Temporary files the model produces while working go through a bypass ledger and are exempt from review within a time window, so you aren't disturbed.

The concrete problem it solves: once DSH enables `workspace-write`, the thing actually blocking dangerous operations is the system elevation confirmation dialog — but that dialog is all English paths and a string of `$ % #` symbols. One glance isn't enough to tell what will happen when you click, and a moment of haste is all it takes to approve.

And even after full-permission mode is on, this plugin can force the model to first investigate the file contents and hand you a readable, risk-tiered, plain-language explanation — giving the decision back to you. (It costs a bit of extra token budget, but that should be worth it...)

## One by one, in plain terms

### Hard limits: these four are never allowed

| Category | Description |
|---|---|
| **Deleting a drive root** | `C:\` `D:\` `E:\`, the root of a plugged-in USB drive... the root directory of any drive. Deleting it means wiping the whole disk. **Applies to deletion only** — copying files into a drive root or listing it is not blocked. |
| **Deleting inside system directories** | `C:\Windows`, `Program Files`, `ProgramData`, `$Recycle.Bin`, `Recovery`, etc. **Hard-blocked in every tier and every mode, including developer mode.** |
| **Deletion / writing with wildcards** | Things like `Remove-Item *.log`. The affected set can't be checked item by item before it runs. **Read-only operations are unrestricted** — `Get-ChildItem *.txt` works as usual. |
| **Changing the plugin's own configuration** | Both are blocked: **config values** (developer mode, tier, switches, exemption window) can only be changed by you in the settings page or via slash commands; **the config files themselves** (the profile's `cordis.patch.yml`, this plugin's `package.json`) can't be written by the model. **Reads are unrestricted** — it can still look. |

For anything that "touches files", native tools, `pwsh` / `bash` commands and the `ops_*` tools registered by the dsh-ops plugin are all treated the same: `ops_remove` hits exactly the same rules as `Remove-Item`, and `ops_read_files` trying to read `state/` is blocked just the same.

### The four tiers

| Tier | Command | Delete | Write / modify | Drive root | System dir · delete | System dir · modify |
|---|---|---|---|---|---|---|
| Read-only allowlist | `/guard-readonly` | Block | Block | Block | Block | Block |
| High interception | `/guard-high` | Block once | Block once | Block | Block | Block |
| Default | `/guard-default` | Block once | Allow | Block | Block | Block once |
| Low guard | `/guard-low` | Allow | Allow | Block | Block | Block once |

- **Block** = no amount of resending gets it through, and the message explicitly says "don't try again".
- **Block once** = the plugin stops it and issues a **one-time token**. The model must get that token from you and resend with it to be allowed. The token covers only the targets blocked this time, and is discarded once used.
- **Allow** = executes directly; the model sees no message.

### What happens after a "block once"

The model receives a prompt and will be asked to:

1. **Explain** — state clearly what it's about to touch, what that's for, and what happens after deletion; if there really is no impact, say plainly "safe to clean up".
2. **Ask you to allow it** — you run `/guard-gettoken` in the input box, get a 16-character token, and type that token to the model.
3. **Resend with the token** — just append a comment to the command: `Remove-Item 'D:\work\old.log' # fg:<the token>`. Comments don't affect execution. The `ops_*` tools have no command line: just resend the exact same call, not a single parameter needs changing.
4. Finish other work in hand first and report together at the end; there's no need to stop and ask one at a time.

**Why the token can be trusted**: the output of slash commands goes only to the log and is not visible in the model's context — what you get from `/guard-gettoken` is something it can neither generate itself nor peek at.

### Temporary files the AI wrote itself: exempt for a limited time

When working, the model produces a pile of one-off things (probe scripts, screenshots, logs, etc.). Asking again just to delete them is mutual torture.

The plugin keeps a bypass ledger recording which paths the model wrote:

- recorded when tools such as `write` / `edit` write a file;
- recorded when commands such as `Set-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Move-Item` run, capturing the paths appearing in the command;
- deleting those paths afterwards is allowed directly under the **low guard / default** tiers.

**Only paths registered in the ledger are recognized** — files you created yourself aren't on it and still need confirmation. That's also why it doesn't touch file contents and doesn't look at creation times.

Four limits:

1. **Directories are not exempt**: a freshly cloned repo or a just-unpacked package also gets recorded in the ledger, but a wrong deletion is expensive, so it always goes through confirmation.
2. **Wildcards are not exempt.**
3. **Not in effect under the high-interception / read-only allowlist tiers.**
4. **The window is limited**: 8 hours by default, after which the exemption no longer applies; the ledger holds at most 5000 entries, and the oldest are evicted by time once it overflows.

Adjust the window with `/guard-temp`:

| Command | Effect |
|---|---|
| `/guard-temp` | Cycle: 1 → 4 → 8 → 24 → 72 → off |
| `/guard-temp 12` | Set directly to 12 hours |
| `/guard-temp 0` | Turn this mechanism off |

### The state directory

The plugin keeps what must stay secret in `state/` under the plugin directory:

| File | Contents |
|---|---|
| `tokens.json` | Pending approval tokens and the targets they authorize |
| `ai-created.json` | The bypass ledger |

**Any access to this directory is hard-blocked by the guard, reads included.** Whatever the tier and whatever the tool, all are refused. The reason: all of this guard's authority lives in these two files; if the model could glance at them, there would be no guard at all.

Tier, window, and switches are **not** in `state/` — they live in the plugin config (the profile's `cordis.patch.yml` layer), which is why the settings page can change them. That **config file itself is protected too**: if the model tries to modify `cordis.patch.yml` or this plugin's `package.json` directly with `Set-Content` / `edit`, it is likewise blocked (reads are not blocked). Both routes are sealed; the only thing it can move is commands in the chat box — and the values those commands change are ultimately clicked by you.

**How you change it yourself**: the guard blocks the model, not you. A click in the settings page is the easiest; editing the config file directly or using `/guard-*` commands also works.

### Known boundaries

**This is a soft constraint, not a security boundary.** It cannot stop a model determined to delete something:

- Deletions written differently are invisible: overwriting via `robocopy /MIR`, JS assembled on the fly inside `run_code`, and tricks like `getattr(os,'remove')` that avoid the literal name.
- Deletions inside inline scripts are partly caught: `os.remove` / `shutil.rmtree` / `fs.rmSync` / `[IO.File]::Delete` appearing in `python -c`, `node -e`, `pwsh -Command` or `bash -c` count as deletion; aliases, string concatenation and indirect calls still slip through.
- The `run_code` tool can delete files by assembling JavaScript on the fly, with no command parsing involved, so it is out of scope; `write` / `edit` only check the state directory and config files, and writing anywhere else isn't blocked.
- The ops tools are recognised by "tool name + argument shape". If dsh-ops renames them or changes their arguments, the guard has to be updated — unknown ops tools whose names carry delete/write wording are already caught by the fallback, but names that look nothing like it are not.
- The state directory lock relies on "invisibility" rather than permissions — the model can bypass it by writing the path differently (assembling strings at runtime, building them on the fly inside `node -e`).

What it can do is raise the bar so you have time to hit the brakes; real physical isolation has to come from OS ACLs, or from the somewhat more troublesome `workspace-write`.

## Installation

**Prerequisite**: the plugin directory must be able to resolve `@deepseek-ai/schemastery` (a dependency provided by the host). When installing into a profile with `link:`, if the plugin isn't under the profile's `node_modules` search path, you must add a junction manually — see "Dependency pitfall" below.

### Option 1: install from a local directory (most reliable)

```powershell
dsh plugin --profile <profile-name> add <absolute path to this repo>
```

### Option 2: mount manually

1. Put the repo anywhere, e.g. `~/.dsh/plugins/dsh-fileguard`.
2. Add two things to the target profile's `package.json`:

   ```jsonc
   {
     "dependencies": {
       "dsh-fileguard": "link:<absolute path to repo>"
     },
     "dsh": {
       "profile": {
         "bundles": [ ..., "dsh-fileguard" ]      // ← must be registered, otherwise it won't load
       }
     }
   }
   ```

3. Run `pnpm install` in the profile directory.
4. Restart DSH.

### Dependency pitfall (must read)

If there is no `node_modules/@deepseek-ai` under the plugin directory, module loading reports:

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

`link:` only solves "can the package be found"; imports inside the package walk up from the real path to find `node_modules`. Add a junction:

```powershell
New-Item -ItemType Junction `
  -Path "<plugin dir>\node_modules\@deepseek-ai" `
  -Target "<profile dir>\node_modules\@deepseek-ai"
```

### How to mount: use bundles, not `- insert:`

Forcing the plugin into the profile's `cordis.patch.yml` with `- insert:` makes the loader record it as `include:dsh-fileguard`; **`configEditor` refuses to write to such an entry**, and both the settings page and slash commands report `Configuration for "dsh-fileguard" is overridden by a home patch`.

The right way is to register the package name in `dsh.profile.bundles` (see option 2, step 2 above); leave at most a switch in `cordis.patch.yml`:

```yaml
- id: dsh-fileguard
  disabled: false
```

### Verify the installation

After restarting, check the log (default `%TEMP%\dsh-fileguard.log`); there should be two lines:

```
apply; tools=object enabled=true policy=default
commands: /guard-low /guard-default /guard-high /guard-readonly /guard-temp /guard-gettoken /guard-cleantoken /guard-dev
```

Only the first line = the plugin loaded but commands weren't registered (the `commands` service became ready after 20 seconds); neither line = the plugin didn't load.

A "**File Guard**" entry should appear on the left side of the settings page.

## Let an agent install it for you

Send the following straight to the agent:

> Install the dsh-fileguard plugin for me:
> 1. Put the repo at `~/.dsh/plugins/dsh-fileguard`.
> 2. In the profile's `package.json`, add `"dsh-fileguard": "link:<path>"` to dependencies, and append `"dsh-fileguard"` to the end of `dsh.profile.bundles`.
> 3. If there is no `node_modules/@deepseek-ai` under the plugin directory, create a junction pointing to the same directory in the profile.
> 4. Run `pnpm install` in the profile directory.
> 5. Don't mount it via `cordis.patch.yml`'s `- insert:`; that would make the config unwritable.
> 6. Let me restart DSH, then check whether the log has the two lines `apply;` and `commands:`.
>
> **When done, tell me:**
> - The settings page has a new "File Guard" section on the left, where I can change the switches, tier, temporary-file exemption window, prompt reset, and developer mode.
> - When a command is blocked normally, I need to type `/guard-gettoken` in the chat box to get a token for it.
> - The tier can be switched anytime with `/guard-low` `/guard-default` `/guard-high` `/guard-readonly`, or directly from the settings page.
> - For debugging I can temporarily loosen it with `/guard-dev on` (drive roots and system directories are still blocked); remember to `/guard-dev off` afterwards.
> - This is a soft constraint, not a security boundary; don't expect it to stop a model determined to delete something.

## Configuration fields

All can be changed in **Settings → File Guard**, or written into the profile's `cordis.patch.yml`.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. When off, all commands pass directly — as if not installed |
| `policy` | string | `"default"` | Guard strength: `low` / `default` / `high` / `readonly` |
| `tempHours` | number | `8` | AI temporary-file exemption window (hours). `0` = turn the mechanism off; max 720 |
| `hintResetAt` | number | `0` | Prompt initialization: change to a new timestamp and the "show once" explanation appears again |
| `devMode` | boolean | `false` | Developer mode: allows ordinary deletions/modifications, the `state/` directory, and the plugin's own config files (this may make it easier to ask an agent to customize the plugin for you, but it also becomes very dangerous); only logged. **Drive roots and system directories are still hard-blocked** |
| `protectedDirs` | string[] | see below | Additional protected directories, including everything beneath them |
| `readOnlyMode` | boolean | `false` | Equivalent to `policy: "readonly"`; kept for compatibility with old configs |

The default value of `protectedDirs` is derived from system environment variables and usually contains:

```
C:\Windows  C:\Program Files  C:\Program Files (x86)  C:\ProgramData
C:\Windows.old  C:\$Recycle.Bin  C:\System Volume Information
C:\Recovery  C:\Boot  C:\PerfLogs
```

Drive roots are not in this list — they're determined separately by a regex, and all drive letters are blocked.

## Commands

| Command | Purpose |
|---|---|
| `/guard-low` `/guard-default` `/guard-high` `/guard-readonly` | Switch tiers |
| `/guard-temp [hours]` | Adjust the temporary-file exemption window; without an argument it cycles, `0` turns it off |
| `/guard-gettoken` | Fetch the token for the pending batch; if several are blocked it lists them all at once, one token each (**this is for the user; the model cannot see the output**) |
| `/guard-cleantoken` | Wipe every pending token at once; all of them stop working immediately (use it when you're not sure what that batch was about to approve) |
| `/guard-dev [on\|off]` | Toggle developer mode; without an argument it inverts |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DSH_FILEGUARD_LOG` | `%TEMP%\dsh-fileguard.log` | Log path |
| `DSH_FILEGUARD_STATE` | `<plugin dir>\state` | State directory, mainly for testing |

## Technical details

**Interception entry point**: `ctx.tools.guard((exec) => string | undefined)`. Returning a string means deny, and that string is handed to the model as a prompt; returning `undefined` allows it. `exec.name` is the tool name; `exec.arguments` is a frozen parameter snapshot.

**Decision order** (`check()`):

```
enabled=false → allow
devMode=true  → allow ordinary operations only, still check drive roots / system dirs first
state/ or config file → hard block (config files only for write-type tools; reads allowed)
ops_* mutation tool → allow dryRun; otherwise fall through to the same checks below
non-shell tool → allow (write/edit targets are only inspected by the state/config checks)
wildcard detected → hard block
drive root (delete only) → hard block
protectedHit → system directories
  ├ high + system dir → hard block
  └ system dir delete → hard block in every tier
readonly tier → block everything outside the read-only allowlist
low tier → deletion allowed
high tier → both deletion and writing blocked
otherwise → token check → block once and issue a token
```

**token**: 16 characters, with `I O 0 1` removed from the alphabet to avoid transcription errors; stored in `state/tokens.json`; the same batch of targets reuses one token, which is deleted once used. Recognition regex `#\s*fg[:\-]([A-Za-z0-9]{16})\b`; after matching, it is stripped from the command before paths are parsed, so the token isn't treated as a filename.

**Path normalization**: lowercase, backslashes to forward slashes, trailing slash removed; drive roots are matched exactly with `/^[a-z]:\\$/` (never `startsWith('c:\\')`, which would lock the entire drive).

**Commands whose paths can't be extracted** (`git clean -fdx`, `robocopy /MIR`) bind the token to a signature of the command text `cmd:<kind>|<normalized command>`, leaving no "resend and it passes" escape hatch. The same applies to `ops_batch` with an `operationsRef` and no inline `operations` — when it's impossible to see which files are affected, the call is held to that signature.

**Path styles** in this context: `C:\`, `C:/`, `\\server\` and git-bash's `/c/Users/...` are all recognised. An MSYS path is normalised to `c:/Users/...` before comparison — otherwise a path written in git-bash notation would never match the `C:`-style path stored in the token.

**The dsh-ops tool set**: `ops_remove`, `ops_write_file`, `ops_edit_file`, `ops_replace`, `ops_copy`, `ops_move` and `ops_batch` (when `action` is `run` / `resume`) are handled with the same authority as shell commands — tiers, drive roots, system directories, `state/` and config files all apply exactly as before; `dryRun: true`, `action=plan` and the read-only ops tools (`ops_stat`, `ops_grep`, `ops_result`, ...) are unaffected. Paths are taken from `path` / `to` / `files[].path` / `pattern` / `glob[]` / `script_path` / `workdir`, and `ops_batch` additionally joins `operations[].path` and `operations[].to` onto `root` as absolute paths. The `ops_` prefix is hardcoded in `dsh-ops/lib/policy.js` and can't be changed; unknown ops tools whose names contain `remove/move/rename/write/edit/replace/copy/truncate/batch` are also treated as mutations, so a plugin upgrade can't quietly open a new back door.

**How ops tools carry a token**: they have no command line, and their argument schemas are closed (`additionalProperties: false`), so `# fg:<token>` cannot be smuggled in. Instead, `/guard-gettoken` marks the token as `seen` at the moment you see it — only a token you have personally laid eyes on may pass through the ops channel; the model can't fetch it from `state/tokens.json`, which is hard-blocked for it. Just have it resend the identical call, without changing a single parameter. When several batches are blocked, `/guard-gettoken` lists every one of them with its own token, none overwriting another; a batch expires only when its own token is used up, and the rest stay put.

**Path styles**: `C:\`, `C:/`, `\\server\` and git-bash's `/c/Users/...` are all recognised. An MSYS path is normalised to `c:/Users/...` before being compared with the paths recorded in the token, so resending the same file in a different notation still matches — it never degrades into a mismatched `cmd:` signature.

**Bypass ledger**: records paths only, never contents. For `write`/`edit` it reads from `file_path`/`filePath`/`path`/`target`/`filename`; for shell commands from `extractPaths()`; for ops mutation tools from `targetPathList()`. Directories are not accepted.

**State directory protection**: path matching at three levels — the whole absolute path, the `dsh-fileguard/state` segment (catching unnormalized relative paths), and the `glob` `pattern`. Native tools, shell commands and ops tools all go through the same path extraction.

**Config file protection** (`touchesConfigFile()`): applies only to write-type calls (shell tools, or `write` / `edit` / `str_replace_editor` / `apply_patch` / `multi_edit`); reads pass. Match condition — `cordis.patch.yml` appears in the command or target path; or both `package.json` and `dsh-fileguard` appear (blocking every `package.json` would make normal development impossible).

**Config writes**: command handlers must return synchronously while `configEditor.edit` is async, so it's fire-and-forget; after the change the loader reloads the plugin (usually a second or two).

**Frontend**: `lib/client.js` is wrapped by ModuleLoader, `require('react')` is externalized (host singleton; bundling it in causes double React and crashes slots), registers `id: 'dsh-fileguard'` / `order: 45` / `label: '文件守卫'` via `ctx.slots.inject('settings.section', ...)`, and reads/writes through the scope obtained from `configForms.get('dsh-fileguard')`.

## License

MIT, see [LICENSE](./LICENSE).

---

# Русский

Плагин-страж файлов для **DeepSeek Harness**.

В режиме полных прав он встаёт на пути модели перед тем, как она что-либо удалит или изменит: модель обязана остановиться и объяснить обычным языком «что это, зачем нужно, что будет, если удалить или изменить». Решение о пропуске принимаете вы с помощью токена (по сути, ключа). Временные файлы, которые модель создаёт по ходу работы, идут через обходной реестр и в пределах временного окна не требуют подтверждения, так что вам не мешают.

Какую конкретную проблему он решает: когда в DSH включён `workspace-write`, по-настоящему опасные операции блокирует системное окно подтверждения повышения прав — но в нём только английские пути и строка символов `$ % #`. С одного взгляда не понять, что произойдёт после нажатия, и одного порыва достаточно, чтобы согласиться.

И даже когда режим полных прав уже включён, этот плагин может заставить модель сначала изучить содержимое файлов и выдать читаемое объяснение на естественном языке, разложенное по уровням риска, — а решение вернуть вам. (Это стоит немного дополнительного бюджета токенов, но оно того стоит...)

## Разбираем по пунктам

### Жёсткие ограничения: эти четыре случая не пропускаются никогда

| Категория | Описание |
|---|---|
| **Удаление корня диска** | `C:\` `D:\` `E:\`, корень подключённой флешки... корневой каталог любого диска. Удалить его — значит стереть весь диск. **Срабатывает только при удалении** — копирование файлов в корень диска или просмотр его содержимого не блокируются. |
| **Удаление внутри системных каталогов** | `C:\Windows`, `Program Files`, `ProgramData`, `$Recycle.Bin`, `Recovery` и т. п. **Жёстко блокируется на любом уровне и в любом режиме, включая режим разработчика.** |
| **Удаление / запись с подстановочными знаками** | Вроде `Remove-Item *.log`. Проверить каждую затронутую единицу до выполнения невозможно. **Операции только для чтения не ограничены** — `Get-ChildItem *.txt` работает как обычно. |
| **Изменение собственной конфигурации плагина** | Блокируется и то, и другое: **значения параметров** (режим разработчика, уровень, переключатели, окно освобождения от подтверждения) можете менять только вы — на странице настроек или слэш-командами; **сами файлы конфигурации** (профильный `cordis.patch.yml`, `package.json` этого плагина) модель записать не может. **Чтение не ограничено** — смотреть она может. |

В вопросах «трогать файлы» нативные инструменты, команды `pwsh` / `bash` и инструменты `ops_*`, регистрируемые плагином dsh-ops, обрабатываются одинаково: `ops_remove` натыкается на те же правила, что и `Remove-Item`, а `ops_read_files`, пытающийся прочитать `state/`, блокируется так же жёстко.

### Четыре уровня политики

| Уровень | Команда | Удаление | Запись / изменение | Корень диска | Сист. каталог · удаление | Сист. каталог · изменение |
|---|---|---|---|---|---|---|
| Только чтение (белый список) | `/guard-readonly` | Блок | Блок | Блок | Блок | Блок |
| Высокое перехватывание | `/guard-high` | Блок один раз | Блок один раз | Блок | Блок | Блок |
| По умолчанию | `/guard-default` | Блок один раз | Пропуск | Блок | Блок | Блок один раз |
| Низкая защита | `/guard-low` | Пропуск | Пропуск | Блок | Блок | Блок один раз |

- **Блок** = сколько ни отправляй повторно, пропущено не будет; в сообщении прямо сказано «не пытайтесь снова».
- **Блок один раз** = плагин останавливает действие и выдаёт **одноразовый токен**. Модель должна получить токен у вас и повторить вызов с ним. Токен покрывает только те цели, что были заблокированы в этот раз, и уничтожается после использования.
- **Пропуск** = выполняется сразу, модель никаких сообщений не видит.

### Что происходит после «блок один раз»

Модель получает подсказку, и её попросят:

1. **Объяснить** — чётко сказать, что именно она собирается затронуть, зачем это нужно и что будет после удаления; если влияния действительно нет, прямо сказать «можно спокойно чистить».
2. **Попросить у вас разрешение** — вы выполняете `/guard-gettoken` в поле ввода, получаете 16-символьный токен и передаёте эту строку модели.
3. **Повторить с токеном** — достаточно добавить комментарий в конце команды: `Remove-Item 'D:\work\old.log' # fg:<этот токен>`. Комментарий не влияет на выполнение. У инструментов `ops_*` нет командной строки: просто повторите тот же вызов без изменений, ни один параметр менять не нужно.
4. Остальные дела можно сначала доделать и отчитаться обо всём сразу в конце; останавливаться и спрашивать по одному не нужно.

**Почему токену можно доверять**: вывод слэш-команд попадает только в лог и не виден в контексте модели — то, что вы получаете через `/guard-gettoken`, она не может ни сгенерировать сама, ни подсмотреть.

### Временные файлы, созданные самим ИИ: без подтверждения в течение ограниченного времени

В работе модель создаёт кучу одноразовых вещей (скрипты-зонды, скриншоты, логи и т. п.). Спрашивать разрешение на их удаление — просто взаимная мука.

Плагин ведёт обходной реестр, в котором записано, какие пути писала модель:

- запись при записи файла инструментами `write` / `edit`;
- запись при выполнении команд `Set-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Move-Item` — берутся пути, встречающиеся в команде;
- последующее удаление этих путей пропускается напрямую на уровнях **низкая защита / по умолчанию**.

**Распознаются только пути, зарегистрированные в реестре** — файлы, созданные вами самими, в него не попадают и по-прежнему требуют подтверждения. Именно поэтому плагин не трогает содержимое файлов и не смотрит на время создания.

Четыре ограничения:

1. **Каталоги не освобождаются**: только что склонированный репозиторий или только что распакованный пакет тоже попадут в реестр, но цена ошибочного удаления велика, поэтому они всегда идут через подтверждение.
2. **Подстановочные знаки не освобождаются.**
3. **Не действует на уровнях высокое перехватывание / только чтение.**
4. **Окно ограничено**: по умолчанию 8 часов, после чего освобождение не действует; в реестре не более 5000 записей, при переполнении самые старые вытесняются по времени.

Окно настраивается командой `/guard-temp`:

| Команда | Действие |
|---|---|
| `/guard-temp` | Циклическое переключение: 1 → 4 → 8 → 24 → 72 → выкл |
| `/guard-temp 12` | Сразу установить 12 часов |
| `/guard-temp 0` | Отключить этот механизм |

### Каталог состояния

Плагин хранит то, что должно оставаться секретным, в `state/` внутри каталога плагина:

| Файл | Содержимое |
|---|---|
| `tokens.json` | Ожидающие токены и цели, которые они разрешают |
| `ai-created.json` | Обходной реестр |

**Любой доступ к этому каталогу жёстко блокируется, включая чтение.** На любом уровне, любым инструментом — всё отклоняется. Причина: вся власть этой защиты заключена в этих двух файлах; если модель сможет хоть раз взглянуть, защиты не останется.

Уровень, окно и переключатели **не** находятся в `state/` — они лежат в конфигурации плагина (на уровне профильного `cordis.patch.yml`), поэтому страница настроек может их менять. **Сам файл конфигурации тоже защищён**: если модель попытается напрямую изменить `cordis.patch.yml` или `package.json` этого плагина через `Set-Content` / `edit`, это тоже будет заблокировано (чтение не блокируется). Оба пути закрыты; двигать она может только команды в окне чата — а значения от этих команд в итоге подтверждаете вы.

**Как менять это вам**: защита блокирует модель, а не вас. Проще всего нажать на странице настроек; можно также править файл конфигурации напрямую или пользоваться командами `/guard-*`.

### Известные границы

**Это мягкое ограничение, а не граница безопасности.** Оно не остановит модель, которая во что бы то ни стало решила что-то удалить:

- Удаление, записанное иначе, не видно: перезапись через `robocopy /MIR`, JS, собранный на ходу внутри `run_code`, и трюки вроде `getattr(os,'remove')`, обходящие литерал.
- Удаление внутри встроенных скриптов теперь частично распознаётся: `os.remove` / `shutil.rmtree` / `fs.rmSync` / `[IO.File]::Delete` в `python -c`, `node -e`, `pwsh -Command` или `bash -c` считаются удалением; но алиасы, склейка строк и косвенные вызовы по-прежнему проскакивают.
- Инструмент `run_code` может удалять файлы, собирая JavaScript на ходу, без какого-либо разбора команд, поэтому он вне зоны действия; `write` / `edit` проверяют только каталог состояния и файлы конфигурации, запись в другие места не блокируется.
- Инструменты ops распознаются по «имени инструмента + структуре аргументов». Если dsh-ops переименует их или изменит аргументы, защиту придётся обновить: неизвестные ops-инструменты, в имени которых есть слова об удалении/записи, ловятся запасным правилом, а вот совсем непохожие имена — нет.
- Замок на каталог состояния держится на «невидимости», а не на правах доступа — модель обойдёт его, если запишет путь иначе (склеит строку во время выполнения, соберёт прямо в `node -e`).

Всё, что можно сделать, — поднять планку, чтобы у вас было время затормозить; настоящая физическая изоляция достигается только средствами ACL операционной системы или более хлопотным `workspace-write`.

## Установка

**Требование**: каталог плагина должен уметь разрешать `@deepseek-ai/schemastery` (зависимость, предоставляемая хостом). При установке в профиль через `link:`, если плагин не находится в путях поиска `node_modules` профиля, нужно вручную добавить junction — см. «Подводный камень с зависимостями» ниже.

### Способ 1: установка из локального каталога (самый надёжный)

```powershell
dsh plugin --profile <profile-name> add <absolute path to this repo>
```

### Способ 2: подключить вручную

1. Положите репозиторий в любое место, например `~/.dsh/plugins/dsh-fileguard`.
2. Добавьте две вещи в `package.json` целевого профиля:

   ```jsonc
   {
     "dependencies": {
       "dsh-fileguard": "link:<absolute path to repo>"
     },
     "dsh": {
       "profile": {
         "bundles": [ ..., "dsh-fileguard" ]      // ← обязательно зарегистрировать, иначе не загрузится
       }
     }
   }
   ```

3. Запустите `pnpm install` в каталоге профиля.
4. Перезапустите DSH.

### Подводный камень с зависимостями (обязательно к прочтению)

Если в каталоге плагина нет `node_modules/@deepseek-ai`, на этапе загрузки модуля будет ошибка:

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

`link:` решает только вопрос «находится ли пакет»; импорты внутри пакета ищут `node_modules` вверх по реальному пути. Добавьте junction:

```powershell
New-Item -ItemType Junction `
  -Path "<plugin dir>\node_modules\@deepseek-ai" `
  -Target "<profile dir>\node_modules\@deepseek-ai"
```

### Способ подключения: через bundles, а не `- insert:`

Если жёстко вставить плагин в `cordis.patch.yml` профиля через `- insert:`, loader запишет его как `include:dsh-fileguard`; **`configEditor` для таких записей всегда отказывает в записи**, и страница настроек, и слэш-команды сообщают `Configuration for "dsh-fileguard" is overridden by a home patch`.

Правильно — зарегистрировать имя пакета в `dsh.profile.bundles` (см. способ 2, шаг 2 выше), а в `cordis.patch.yml` оставить максимум переключатель:

```yaml
- id: dsh-fileguard
  disabled: false
```

### Проверка установки

После перезапуска посмотрите лог (по умолчанию `%TEMP%\dsh-fileguard.log`) — должно быть две строки:

```
apply; tools=object enabled=true policy=default
commands: /guard-low /guard-default /guard-high /guard-readonly /guard-temp /guard-gettoken /guard-cleantoken /guard-dev
```

Только первая строка = плагин загрузился, но команды не зарегистрированы (служба `commands` стала готова позже 20 секунд); нет ни одной = плагин не загрузился.

Слева на странице настроек должен появиться раздел «**Файловый страж**».

## Пусть агент установит за вас

Отправьте агенту этот текст:

> Установи мне плагин dsh-fileguard:
> 1. Положи репозиторий в `~/.dsh/plugins/dsh-fileguard`.
> 2. В `package.json` профиля добавь `"dsh-fileguard": "link:<путь>"` в dependencies и допиши `"dsh-fileguard"` в конец `dsh.profile.bundles`.
> 3. Если в каталоге плагина нет `node_modules/@deepseek-ai`, создай junction на такой же каталог в профиле.
> 4. Запусти `pnpm install` в каталоге профиля.
> 5. Не подключай через `- insert:` в `cordis.patch.yml` — из-за этого конфигурация станет незаписываемой.
> 6. Дай мне перезапустить DSH, затем проверь, есть ли в логе две строки `apply;` и `commands:`.
>
> **Когда закончишь, скажи мне:**
> - Слева на странице настроек появился раздел «Файловый страж», где можно менять переключатели, уровень, окно освобождения временных файлов, сброс подсказок и режим разработчика.
> - Когда команда блокируется, мне нужно ввести `/guard-gettoken` в чате, чтобы получить токен для неё.
> - Уровень можно переключать в любой момент командами `/guard-low` `/guard-default` `/guard-high` `/guard-readonly` или прямо на странице настроек.
> - Для отладки можно временно ослабить защиту через `/guard-dev on` (корни дисков и системные каталоги всё равно блокируются), и не забыть потом `/guard-dev off`.
> - Это мягкое ограничение, а не граница безопасности; не рассчитывай, что оно остановит модель, которая решила что-то удалить.

## Параметры конфигурации

Всё можно менять в **Настройки → Файловый страж**, а также прописать в `cordis.patch.yml` профиля.

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `enabled` | boolean | `true` | Общий переключатель. Когда выключен, все команды проходят напрямую — как будто плагин не установлен |
| `policy` | string | `"default"` | Сила защиты: `low` / `default` / `high` / `readonly` |
| `tempHours` | number | `8` | Окно освобождения временных файлов ИИ (часы). `0` = отключить механизм, максимум 720 |
| `hintResetAt` | number | `0` | Инициализация подсказки: после смены на новую метку времени пояснение «показывается один раз» появится снова |
| `devMode` | boolean | `false` | Режим разработчика: пропускает обычные удаления/изменения, каталог `state/` и собственные файлы конфигурации плагина (так, возможно, удобнее попросить агента доработать плагин под вас, но это и становится очень опасно); только пишется в лог. **Корни дисков и системные каталоги по-прежнему жёстко блокируются** |
| `protectedDirs` | string[] | см. ниже | Дополнительно защищённые каталоги вместе со всем их содержимым |
| `readOnlyMode` | boolean | `false` | Эквивалент `policy: "readonly"`; сохранён для совместимости со старыми конфигурациями |

Значение по умолчанию для `protectedDirs` выводится из системных переменных окружения и обычно содержит:

```
C:\Windows  C:\Program Files  C:\Program Files (x86)  C:\ProgramData
C:\Windows.old  C:\$Recycle.Bin  C:\System Volume Information
C:\Recovery  C:\Boot  C:\PerfLogs
```

Корни дисков в этот список не входят — они определяются отдельно регулярным выражением, и блокируются все буквы дисков.

## Команды

| Команда | Назначение |
|---|---|
| `/guard-low` `/guard-default` `/guard-high` `/guard-readonly` | Переключение уровня |
| `/guard-temp [часы]` | Настроить окно освобождения временных файлов; без аргумента — циклическое переключение, `0` отключает |
| `/guard-gettoken` | Получить токен ожидающей партии; если заблокировано несколько, все они перечисляются сразу, по токену на каждую (**это для пользователя; модель вывода не видит**) |
| `/guard-cleantoken` | Одним разом стереть все ожидающие токены — все сразу перестают работать (когда непонятно, что именно собиралась разрешить та партия) |
| `/guard-dev [on\|off]` | Переключить режим разработчика; без аргумента — инвертировать |

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `DSH_FILEGUARD_LOG` | `%TEMP%\dsh-fileguard.log` | Путь к логу |
| `DSH_FILEGUARD_STATE` | `<plugin dir>\state` | Каталог состояния, в основном для тестов |

## Технические детали

**Точка перехвата**: `ctx.tools.guard((exec) => string | undefined)`. Возврат строки означает отказ, и эта строка передаётся модели как подсказка; возврат `undefined` — пропуск. `exec.name` — имя инструмента, `exec.arguments` — замороженный снимок параметров.

**Порядок принятия решения** (`check()`):

```
enabled=false → пропустить
devMode=true  → пропускать только обычные операции, но сначала по-прежнему проверять корни дисков / системные каталоги
state/ или файл конфигурации → жёсткая блокировка (файлы конфигурации проверяются только для пишущих инструментов; чтение пропускается)
ops_* изменяющий инструмент → пропустить dryRun; иначе перейти к тем же проверкам ниже
не-shell инструмент → пропустить (целевые пути write/edit проверяются только в проверках state/конфигурации)
обнаружен подстановочный знак → жёсткая блокировка
корень диска (только удаление) → жёсткая блокировка
protectedHit → системные каталоги
  ├ high + системный каталог → жёсткая блокировка
  └ удаление в системном каталоге → жёсткая блокировка на любом уровне
уровень readonly → всё вне белого списка только для чтения блокируется
уровень low → удаление пропускается
уровень high → блокируются и удаление, и запись
иначе → проверка токена → блок один раз и выдача токена
```

**token**: 16 символов, из алфавита убраны `I O 0 1` во избежание ошибок при переписывании; хранится в `state/tokens.json`; для одной партии целей переиспользуется один токен, после использования удаляется. Регулярное выражение распознавания `#\s*fg[:\-]([A-Za-z0-9]{16})\b`; после совпадения токен вырезается из команды перед разбором путей, чтобы его не приняли за имя файла.

**Нормализация путей**: всё в нижний регистр, обратные слэши в прямые, завершающий слэш убирается; корни дисков определяются точным совпадением с `/^[a-z]:\\$/` (нельзя `startsWith('c:\\')` — это заблокирует весь диск).

**Команды, у которых пути не извлекаются** (`git clean -fdx`, `robocopy /MIR`), привязывают токен к подписи текста команды `cmd:<kind>|<нормализованная команда>`, не оставляя лазейки «повторил — и прошло». То же самое относится к `ops_batch` с `operationsRef` и без встроенного `operations` — когда невозможно увидеть, какие файлы затрагиваются, вызов привязывается к этой подписи.

**Запись путей** в этом контексте: `C:\`, `C:/`, `\\server\` и git-bash-стиль `/c/Users/...` — всё распознаётся. MSYS-путь нормализуется в `c:/Users/...` перед сравнением — иначе путь в git-bash-записи никогда не совпал бы с путём в стиле `C:` из токена.

**Набор инструментов dsh-ops**: `ops_remove`, `ops_write_file`, `ops_edit_file`, `ops_replace`, `ops_copy`, `ops_move` и `ops_batch` (когда `action` равен `run` / `resume`) обрабатываются с теми же полномочиями, что и shell-команды — уровни, корни дисков, системные каталоги, `state/` и файлы конфигурации действуют ровно так же; `dryRun: true`, `action=plan` и инструменты ops только для чтения (`ops_stat`, `ops_grep`, `ops_result`, ...) не затрагиваются. Пути берутся из `path` / `to` / `files[].path` / `pattern` / `glob[]` / `script_path` / `workdir`, а `ops_batch` дополнительно склеивает `operations[].path` и `operations[].to` с `root` в абсолютные пути. Префикс `ops_` жёстко зашит в `dsh-ops/lib/policy.js` и не меняется; неизвестные ops-инструменты, в имени которых есть `remove/move/rename/write/edit/replace/copy/truncate/batch`, тоже считаются изменяющими, так что обновление плагина не откроет тихо новую лазейку.

**Как инструменты ops несут токен**: у них нет командной строки, а схемы аргументов закрыты (`additionalProperties: false`), поэтому `# fg:<token>` туда не подложить. Вместо этого `/guard-gettoken` помечает токен как `seen` в тот момент, когда вы его увидели — через канал ops может пройти только токен, который вы лично видели; модель не достанет его из `state/tokens.json`, который для неё жёстко заблокирован. Просто попросите её повторить тот же вызов, не меняя ни одного параметра. Если заблокировано несколько партий, `/guard-gettoken` перечислит каждую со своим токеном, не перекрывая друг друга; партия исчезает только когда израсходован её токен, остальные остаются на месте.

**Запись путей**: `C:\`, `C:/`, `\\server\` и git-bash-стиль `/c/Users/...` — всё распознаётся. MSYS-путь сначала нормализуется в `c:/Users/...` и только потом сравнивается с путями в токене, поэтому тот же файл, переотправленный в другой записи, всё равно совпадёт — и не выродится в несовпадающую подпись `cmd:`.

**Обходной реестр**: пишет только пути, не касается содержимого. Для `write`/`edit` берётся из `file_path`/`filePath`/`path`/`target`/`filename`; для shell-команд — из `extractPaths()`; для изменяющих инструментов ops — из `targetPathList()`. Каталоги не принимаются.

**Защита каталога состояния**: сопоставление путей в три слоя — весь абсолютный путь, фрагмент `dsh-fileguard/state` (ловит ненормализованные относительные пути) и `pattern` у `glob`. Нативные инструменты, shell-команды и инструменты ops проходят через одно и то же извлечение путей.

**Защита файлов конфигурации** (`touchesConfigFile()`): действует только для пишущих вызовов (shell-инструменты, или `write` / `edit` / `str_replace_editor` / `apply_patch` / `multi_edit`), чтение пропускается. Условие срабатывания — `cordis.patch.yml` встречается в команде или целевом пути; либо одновременно встречаются `package.json` и `dsh-fileguard` (блокировать все `package.json` нельзя — тогда нормальная разработка станет невозможной).

**Запись конфигурации**: обработчик команды должен возвращать результат синхронно, а `configEditor.edit` асинхронный, поэтому используется fire-and-forget; после изменения loader перезагружает плагин (обычно одну-две секунды).

**Фронтенд**: `lib/client.js` обёрнут через ModuleLoader, `require('react')` вынесен наружу (синглтон хоста; включение в bundle даёт двойной React и ломает slots), регистрирует `id: 'dsh-fileguard'` / `order: 45` / `label: '文件守卫'` через `ctx.slots.inject('settings.section', ...)`, чтение и запись идут через scope, полученный из `configForms.get('dsh-fileguard')`.

## Лицензия

MIT, см. [LICENSE](./LICENSE).

---

# 日本語

**DeepSeek Harness** 用のファイルガードプラグインです。

全権モードでは、モデルが何かを削除・変更する前に一度止めさせ、「これは何か、何に使うのか、削除・変更するとどうなるか」を自然言語で説明させます。そのうえで、あなたがトークン（鍵のようなもの）を使って許可するかどうかを決めます。モデルが作業中に作った一時ファイルはバイパス台帳を通り、時間内は審査免除なので、あなたを煩わせません。

これが解決する具体的な問題：DSH で `workspace-write` を有効にすると、危険な操作を実際に止めているのはシステムの権限昇格確認ダイアログです。しかしそのダイアログは英語のパスと `$ % #` の記号ばかりで、一目見ただけではクリックしたら何が起きるか判断できず、手が滑ればそのまま同意してしまいます。

そして全権モードを有効にした後でも、このプラグインはモデルにファイル内容を先に調べさせ、理解できるリスク階層付きの自然言語の説明を出させ、決定権をあなたに返します。（少し余分なトークンを使いますが、それだけの価値はあるはずです…）

## 一つずつ説明します

### ハード制限：この4種類は決して通しません

| カテゴリ | 説明 |
|---|---|
| **ドライブのルート削除** | `C:\` `D:\` `E:\`、接続した USB メモリのルート……あらゆるドライブのルートディレクトリ。削除はディスク全体の消去に等しい。**削除のときだけ適用** — ルートへのファイルコピーや一覧表示はブロックしません。 |
| **システムディレクトリ内の削除** | `C:\Windows`、`Program Files`、`ProgramData`、`$Recycle.Bin`、`Recovery` など。**すべてのレベル、あらゆるモード（開発者モードを含む）で完全ブロック。** |
| **ワイルドカードを含む削除 / 書き込み** | `Remove-Item *.log` のようなもの。対象範囲を実行前に一つずつ確認できません。**読み取り専用の操作は制限されません** — `Get-ChildItem *.txt` は通常どおり。 |
| **プラグイン自身の設定変更** | 両方ブロックします：**設定値**（開発者モード、レベル、スイッチ、審査免除の時間枠）は設定ページかスラッシュコマンドからあなただけが変更できます；**設定ファイルそのもの**（profile の `cordis.patch.yml`、このプラグインの `package.json`）へのモデルの書き込みはブロックします。**読み取りは制限されません** — 見ることはできます。 |

「ファイルに触る」ことに関しては、ネイティブツール、`pwsh` / `bash` コマンド、そして dsh-ops プラグインが登録する `ops_*` ツールをすべて同じに扱います。`ops_remove` は `Remove-Item` とまったく同じルールに当たり、`ops_read_files` が `state/` を読もうとしても同じように完全ブロックされます。

### 4つのレベル

| レベル | コマンド | 削除 | 書き込み / 変更 | ドライブのルート | システムディレクトリ · 削除 | システムディレクトリ · 変更 |
|---|---|---|---|---|---|---|
| 読み取り専用ホワイトリスト | `/guard-readonly` | 完全ブロック | 完全ブロック | 完全ブロック | 完全ブロック | 完全ブロック |
| 高インターセプト | `/guard-high` | 一度だけブロック | 一度だけブロック | 完全ブロック | 完全ブロック | 完全ブロック |
| デフォルト | `/guard-default` | 一度だけブロック | 通過 | 完全ブロック | 完全ブロック | 一度だけブロック |
| 低ガード | `/guard-low` | 通過 | 通過 | 完全ブロック | 完全ブロック | 一度だけブロック |

- **完全ブロック** = 何度送り直しても通りません。メッセージには「再試行しないでください」と明記されます。
- **一度だけブロック** = プラグインが止め、**ワンタイムトークン**を発行します。モデルはあなたからトークンを受け取り、それを付けて再送しないと実行できません。トークンは今回ブロックされた対象だけをカバーし、使えば失効します。
- **通過** = そのまま実行され、モデルには何も表示されません。

### 「一度だけブロック」の後に何が起きるか

モデルにはプロンプトが渡され、次のことが求められます：

1. **説明** — 何を触ろうとしているのか、何のためか、削除したらどうなるかを明確に伝える。本当に影響がないなら「そのまま削除して問題ありません」と正直に言う。
2. **許可を求める** — あなたが入力欄で `/guard-gettoken` を実行し、16 文字のトークンを取得して、その文字列をモデルに渡します。
3. **トークンを付けて再送** — コマンドの末尾にコメントを足すだけ：`Remove-Item 'D:\work\old.log' # fg:<そのトークン>`。コメントは実行に影響しません。`ops_*` 系にはコマンドラインがないので、同じ呼び出しをそのまま再送するだけです。パラメータを一つも変える必要はありません。
4. 他に手元の作業があれば先に片付け、最後にまとめて報告してよい。一件ずつ止まって聞く必要はありません。

**トークンが信頼できる理由**：スラッシュコマンドの出力はログにだけ残り、モデルのコンテキストには見えません — `/guard-gettoken` で得たものは、モデルが自分で生成することも盗み見ることもできないのです。

### AI 自身が書いた一時ファイル：一定時間は審査免除

モデルが作業すると、使い捨てのもの（調査スクリプト、スクリーンショット、ログなど）が山ほどできます。その削除までいちいち確認するのはお互い苦痛です。

プラグインはバイパス台帳を保持し、モデルが書き込んだパスを記録します：

- `write` / `edit` などのツールがファイルを書いたときに記録；
- `Set-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Move-Item` などのコマンド実行時に、コマンド内に現れるパスを記録；
- その後これらのパスを削除するとき、**低ガード / デフォルト** レベルでは直接通過。

**台帳に登録されたパスだけを認識します** — あなた自身が作成したファイルは台帳にないため、従来どおり確認が必要です。だからこそファイルの中身には触れず、作成時刻も見ません。

4つの制限：

1. **ディレクトリは免除しません**：クローンしたばかりのリポジトリや展開したばかりのパッケージも台帳に入りますが、誤削除の代償が大きいため、必ず確認を通します。
2. **ワイルドカードは免除しません。**
3. **高インターセプト / 読み取り専用ホワイトリストのレベルでは効きません。**
4. **時間枠は有限**：既定 8 時間、過ぎると免除されません；台帳は最大 5000 件、超えたら古いものから時間順に追い出されます。

時間枠は `/guard-temp` で調整します：

| コマンド | 効果 |
|---|---|
| `/guard-temp` | 循環切替：1 → 4 → 8 → 24 → 72 → オフ |
| `/guard-temp 12` | 直接 12 時間に設定 |
| `/guard-temp 0` | この仕組みをオフにする |

### 状態ディレクトリ

プラグインは秘匿すべきものを、プラグインのディレクトリ下の `state/` に置きます：

| ファイル | 内容 |
|---|---|
| `tokens.json` | 承認待ちのトークンと、それが許可する対象 |
| `ai-created.json` | バイパス台帳 |

**このディレクトリへのあらゆるアクセスは完全ブロックされ、読み取りも同様です。** どのレベルでも、どのツールでもすべて拒否されます。理由：このガードの権威はすべてこの2つのファイルにあり、モデルが一度でも見ればガードは意味を失うからです。

レベル・時間枠・スイッチは `state/` には**ありません** — プラグイン設定（profile の `cordis.patch.yml` の層）にあり、だから設定ページで変更できます。その**設定ファイル自体も保護されています**：モデルが `Set-Content` / `edit` で `cordis.patch.yml` やこのプラグインの `package.json` を直接書き換えようとしても、同様にブロックされます（読み取りはブロックしません）。両方の経路が塞がれており、モデルが動かせるのはチャット欄のコマンドだけ——そしてそのコマンドが変える値は、最終的にあなたがクリックしたものです。

**あなた自身が変更する方法**：ガードが止めるのはモデルであって、あなたではありません。設定ページでクリックするのが一番簡単です。設定ファイルを直接編集するか、`/guard-*` コマンドを使ってもかまいません。

### 既知の限界

**これはソフトな制約であり、セキュリティ境界ではありません。** 何としても削除しようとするモデルは止められません：

- 別の書き方の削除は見えません：`robocopy /MIR` による上書き、`run_code` 内でその場で組み立てた JS、`getattr(os,'remove')` のようなリテラルを避ける書き方。
- インラインスクリプト内の削除は一部だけ認識します：`python -c`、`node -e`、`pwsh -Command`、`bash -c` の中に `os.remove` / `shutil.rmtree` / `fs.rmSync` / `[IO.File]::Delete` があれば削除として扱いますが、エイリアス・文字列連結・間接呼び出しはすり抜けます。
- `run_code` はその場で JavaScript を組み立ててファイルを削除でき、コマンド解析を一切通らないため管轄外です。`write` / `edit` は状態ディレクトリと設定ファイルだけを確認し、それ以外の場所への書き込みはブロックしません。
- ops ツールは「ツール名 + 引数の構造」で識別しています。dsh-ops が名前や引数を変えたらガード側も更新が必要です。削除・書き込みを思わせる語を含む未知の ops ツールは予備ルールで拾いますが、まったく似ていない名前に変わると拾えません。
- 状態ディレクトリのロックは権限ではなく「見えないこと」に頼っています — モデルがパスを書かない形（実行時に文字列を組み立てる、`node -e` の中でその場で組む）に変えれば回避できます。

できるのはハードルを上げて、あなたがブレーキを踏む時間を作ることです。本当の物理的隔離は OS の ACL か、やや面倒な `workspace-write` に頼るしかありません。

## インストール

**前提**：プラグインのディレクトリは `@deepseek-ai/schemastery`（ホストが提供する依存）を解決できる必要があります。`link:` で profile にインストールする場合、プラグインが profile の `node_modules` 検索パス上にないなら、junction を手動で追加する必要があります — 下の「依存関係の落とし穴」を参照。

### 方法1：ローカルディレクトリからインストール（最も確実）

```powershell
dsh plugin --profile <profile-name> add <absolute path to this repo>
```

### 方法2：手動でマウント

1. リポジトリを任意の場所に置きます。例：`~/.dsh/plugins/dsh-fileguard`。
2. 対象 profile の `package.json` に2か所追加します：

   ```jsonc
   {
     "dependencies": {
       "dsh-fileguard": "link:<absolute path to repo>"
     },
     "dsh": {
       "profile": {
         "bundles": [ ..., "dsh-fileguard" ]      // ← 必ず登録。登録しないと読み込まれません
       }
     }
   }
   ```

3. profile のディレクトリで `pnpm install` を実行します。
4. DSH を再起動します。

### 依存関係の落とし穴（必読）

プラグインのディレクトリに `node_modules/@deepseek-ai` がないと、モジュール読み込み段階で次のエラーが出ます：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

`link:` が解決するのは「パッケージが見つかるかどうか」だけです。パッケージ内部の import は実パスから上へ `node_modules` を探します。junction を追加してください：

```powershell
New-Item -ItemType Junction `
  -Path "<plugin dir>\node_modules\@deepseek-ai" `
  -Target "<profile dir>\node_modules\@deepseek-ai"
```

### マウント方法：bundles を使い、`- insert:` は使わない

profile の `cordis.patch.yml` で `- insert:` を使って無理やり挿し込むと、loader はそれを `include:dsh-fileguard` として記録します。この種の entry には **`configEditor` が一律で書き込みを拒否し**、設定ページもスラッシュコマンドも `Configuration for "dsh-fileguard" is overridden by a home patch` を報告します。

正しい方法は、パッケージ名を `dsh.profile.bundles` に登録すること（上の方法2の手順2を参照）。`cordis.patch.yml` にはスイッチを最大1つだけ残します：

```yaml
- id: dsh-fileguard
  disabled: false
```

### インストールの確認

再起動後にログ（既定 `%TEMP%\dsh-fileguard.log`）を見てください。2行あるはずです：

```
apply; tools=object enabled=true policy=default
commands: /guard-low /guard-default /guard-high /guard-readonly /guard-temp /guard-gettoken /guard-cleantoken /guard-dev
```

1行目だけ = プラグインは読み込まれたがコマンドが登録されていない（`commands` サービスの準備が 20 秒より遅かった）；どちらもない = プラグインが読み込まれていない。

設定ページの左側に「**ファイルガード**」の項目が現れるはずです。

## エージェントにインストールしてもらう

以下をそのままエージェントに送ってください：

> dsh-fileguard プラグインを入れてください：
> 1. リポジトリを `~/.dsh/plugins/dsh-fileguard` に置く。
> 2. profile の `package.json` の dependencies に `"dsh-fileguard": "link:<パス>"` を追加し、`dsh.profile.bundles` の末尾に `"dsh-fileguard"` を追加する。
> 3. プラグインのディレクトリに `node_modules/@deepseek-ai` がなければ、profile の同じディレクトリを指す junction を作る。
> 4. profile のディレクトリで `pnpm install` を実行する。
> 5. `cordis.patch.yml` の `- insert:` ではマウントしない。設定が書き込めなくなるため。
> 6. 私に DSH を再起動させ、ログに `apply;` と `commands:` の2行があるか確認する。
>
> **終わったら教えてください：**
> - 設定ページの左側に「ファイルガード」の項目が増え、スイッチ・レベル・一時ファイルの審査免除時間枠・プロンプトのリセット・開発者モードを変更できる。
> - コマンドがブロックされたときは、チャット欄で `/guard-gettoken` を打ってトークンを取得し、モデルに渡す必要がある。
> - レベルは `/guard-low` `/guard-default` `/guard-high` `/guard-readonly` でいつでも切り替えられる。設定ページから直接でもよい。
> - デバッグ時は `/guard-dev on` で一時的に緩められる（ドライブのルートとシステムディレクトリは依然ブロック）。使い終わったら `/guard-dev off` を忘れずに。
> - これはソフトな制約であり、セキュリティ境界ではない。削除しようとするモデルを止められるとは期待しないこと。

## 設定項目

すべて**設定ページ → ファイルガード**で変更できます。profile の `cordis.patch.yml` に書くこともできます。

| フィールド | 型 | 既定値 | 説明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 全体スイッチ。オフにするとすべてのコマンドが直接通過し、未インストールと同じになる |
| `policy` | string | `"default"` | ガードの強さ：`low` / `default` / `high` / `readonly` |
| `tempHours` | number | `8` | AI の一時ファイル審査免除の時間枠（時間）。`0` = この仕組みをオフ、上限 720 |
| `hintResetAt` | number | `0` | プロンプトの初期化：新しいタイムスタンプに変えると、「一度だけ表示」の説明が再び現れる |
| `devMode` | boolean | `false` | 開発者モード：通常の削除・変更、`state/` ディレクトリ、プラグイン自身の設定ファイルを通過させる（こうすればエージェントに頼んでこのプラグインをカスタマイズしてもらいやすくなるかもしれませんが、とても危険にもなります）。ログのみ記録。**ドライブのルートとシステムディレクトリは依然として完全ブロック** |
| `protectedDirs` | string[] | 下記参照 | 追加で保護するディレクトリ。その下のすべてを含む |
| `readOnlyMode` | boolean | `false` | `policy: "readonly"` と同等。古い設定との互換のため残存 |

`protectedDirs` の既定値はシステム環境変数から導出され、通常は次を含みます：

```
C:\Windows  C:\Program Files  C:\Program Files (x86)  C:\ProgramData
C:\Windows.old  C:\$Recycle.Bin  C:\System Volume Information
C:\Recovery  C:\Boot  C:\PerfLogs
```

ドライブのルートはこの一覧には含まれません — 正規表現で別途判定し、すべてのドライブレターをブロックします。

## コマンド

| コマンド | 役割 |
|---|---|
| `/guard-low` `/guard-default` `/guard-high` `/guard-readonly` | レベルの切り替え |
| `/guard-temp [時間]` | 一時ファイルの審査免除時間枠を調整；引数なしで循環切替、`0` でオフ |
| `/guard-gettoken` | 承認待ちバッチのトークンを取り出す。複数ブロックされていれば一度にすべて列挙され、それぞれに 1 つのトークンが付く（**これはあなた用。モデルは出力を見られません**） |
| `/guard-cleantoken` | 承認待ちのトークンをすべて一度に消す。すべて即座に無効になります（そのバッチが何を許可しようとしていたか分からないときに） |
| `/guard-dev [on\|off]` | 開発者モードの切り替え；引数なしで反転 |

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `DSH_FILEGUARD_LOG` | `%TEMP%\dsh-fileguard.log` | ログのパス |
| `DSH_FILEGUARD_STATE` | `<plugin dir>\state` | 状態ディレクトリ。主にテスト用 |

## 技術的な詳細

**インターセプトの入口**：`ctx.tools.guard((exec) => string | undefined)`。文字列を返すと拒否し、その文字列をプロンプトとしてモデルに渡します。`undefined` を返すと通過。`exec.name` はツール名、`exec.arguments` は凍結されたパラメータのスナップショットです。

**判定順序**（`check()`）：

```
enabled=false → 通過
devMode=true  → 通常操作のみ通過。ただし先にドライブのルート / システムディレクトリを確認
state/ または設定ファイル → 完全ブロック（設定ファイルは書き込み系ツールのみ確認、読み取りは通過）
ops_* の変更系ツール → dryRun なら通過、それ以外は下の同じ判定へ
shell 以外のツール → 通過（write/edit の対象パスは状態/設定の確認でだけ見る）
ワイルドカード検出 → 完全ブロック
ドライブのルート（削除時のみ） → 完全ブロック
protectedHit → システムディレクトリ
  ├ high + システムディレクトリ → 完全ブロック
  └ システムディレクトリの削除 → すべてのレベルで完全ブロック
readonly レベル → 読み取り専用ホワイトリスト以外はすべてブロック
low レベル → 削除を通過
high レベル → 削除も書き込みもブロック
それ以外 → トークン検証 → 一度だけブロックしてトークン発行
```

**token**：16 文字。書き写し間違いを避けるためアルファベットから `I O 0 1` を除外。`state/tokens.json` に保存し、同じ対象バッチでは同じトークンを再利用、使えば削除。認識用正規表現 `#\s*fg[:\-]([A-Za-z0-9]{16})\b`。マッチ後、パス解析の前にコマンドから取り除き、トークンがファイル名として扱われないようにします。

**パスの正規化**：すべて小文字化、バックスラッシュをスラッシュへ、末尾スラッシュを削除。ドライブのルートは `/^[a-z]:\\$/` で厳密に判定（`startsWith('c:\\')` は不可 — ディスク全体をロックしてしまう）。

**パスを抽出できないコマンド**（`git clean -fdx`、`robocopy /MIR`）は、コマンド原文の署名 `cmd:<kind>|<正規化コマンド>` にトークンを結びつけ、「再送すれば通る」という抜け道を残しません。`ops_batch` が `operationsRef` を使い、インラインの `operations` を持たない場合も同じです — どのファイルが対象か見えないときは、この署名に縛ります。

**パスの書き方**：`C:\`、`C:/`、`\\server\`、git-bash の `/c/Users/...` をすべて認識します。MSYS 形式のパスは照合前に `c:/Users/...` へ正規化されます — そうしないと git-bash 形式のパスが、トークンに記録された `C:` 形式のパスと永久に一致しません。

**dsh-ops ツール群**：`ops_remove`、`ops_write_file`、`ops_edit_file`、`ops_replace`、`ops_copy`、`ops_move`、および `ops_batch`（`action` が `run` / `resume` のとき）は shell コマンドと同じ権限で扱います — レベル、ドライブのルート、システムディレクトリ、`state/`、設定ファイルがこれまでどおり効きます。`dryRun: true`、`action=plan`、読み取り専用の ops ツール（`ops_stat`、`ops_grep`、`ops_result` など）は影響を受けません。パスは `path` / `to` / `files[].path` / `pattern` / `glob[]` / `script_path` / `workdir` から取り、`ops_batch` はさらに `operations[].path` と `operations[].to` を `root` に結合して絶対パスにします。`ops_` の接頭辞は `dsh-ops/lib/policy.js` にハードコードされていて変更できません。名前に `remove/move/rename/write/edit/replace/copy/truncate/batch` を含む未知の ops ツールも変更系として扱うので、プラグインの更新で静かに新しい抜け道が開くことはありません。

**ops ツールがトークンをどう受け取るか**：コマンドラインがなく、引数のスキーマも閉じている（`additionalProperties: false`）ため、`# fg:<token>` を紛れ込ませることはできません。代わりに `/guard-gettoken` が、あなたがトークンを見たその瞬間に `seen` の印を付けます — ops の経路を通れるのは、あなた自身が目にしたトークンだけです。モデルが `state/tokens.json` から取り出すことはできません（そのディレクトリはモデルに対して完全ブロックです）。同じ呼び出しをパラメータ一つ変えずに再送させるだけで済みます。複数のバッチがブロックされている場合、`/guard-gettoken` はそれぞれに専用のトークンを付けて全部列挙し、互いに上書きしません。使われたバッチだけが失効し、残りはそのまま残ります。

**パスの書き方**：`C:\`、`C:/`、`\\server\`、そして git-bash の `/c/Users/...` をすべて認識します。MSYS 形式はまず `c:/Users/...` に正規化してからトークン内のパスと照合するので、同じファイルを別の書き方で再送しても一致します — 食い違う `cmd:` 署名に退化することはありません。

**バイパス台帳**：パスのみ記録し、中身には触れません。`write`/`edit` は `file_path`/`filePath`/`path`/`target`/`filename` から取得；shell コマンドは `extractPaths()` から取得；ops の変更系ツールは `targetPathList()` から取得。ディレクトリは受け付けません。

**状態ディレクトリの保護**：パス照合は三層 — 絶対パス全体、`dsh-fileguard/state` の断片（正規化されていない相対パスを捕捉）、`glob` の `pattern`。ネイティブツール、shell コマンド、ops ツールは同じパス抽出を通ります。

**設定ファイルの保護**（`touchesConfigFile()`）：書き込み系の呼び出しにのみ有効（shell ツール、または `write` / `edit` / `str_replace_editor` / `apply_patch` / `multi_edit`）。読み取りは通過。発動条件 — コマンドまたは対象パスに `cordis.patch.yml` が現れる；または `package.json` と `dsh-fileguard` が同時に現れる（すべての `package.json` をブロックすると通常の開発ができなくなるため）。

**設定の書き込み**：コマンドハンドラは同期的に返す必要があり、`configEditor.edit` は async なので fire-and-forget。変更後は loader がプラグインを再読み込みして反映します（通常 1〜2 秒）。

**フロントエンド**：`lib/client.js` は ModuleLoader でラップされ、`require('react')` は外部化（ホストのシングルトン。bundle に含めると二重 React になり slots が落ちる）。`ctx.slots.inject('settings.section', ...)` で `id: 'dsh-fileguard'` / `order: 45` / `label: '文件守卫'` を登録し、読み書きは `configForms.get('dsh-fileguard')` で得た scope を通します。

## ライセンス

MIT。[LICENSE](./LICENSE) を参照。
