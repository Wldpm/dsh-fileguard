# dsh-fileguard

给 **DeepSeek Harness** 用的文件守卫插件。

模型动手删东西、改东西之前先拦一道，逼它停下来把「动的是什么、有什么用、删了会怎样」用中文讲清楚，再由你决定放不放行。模型自己干活时产生的临时文件走旁路台账，窗口期内免审，不打扰你。

它解决的具体问题：DSH 开 `workspace-write` 之后，真正拦危险操作的是系统提权确认框，而那个框里全是英文路径和一串 `$ % #` 符号，扫一眼判断不了点下去会发生什么，手一快就同意了。这个插件在弹窗之前先给一份能看懂的中文说明。

---

## 一条一条说清楚

### 硬限制：这四类永远不放行

| 类别 | 说明 |
|---|---|
| **盘根的删除** | `C:\` `D:\` `E:\`、插上来的 U 盘盘根……任何盘的根目录。删它等于清空整块盘。**只在删除时生效**——往盘根里复制文件、列举盘根都不拦。 |
| **系统目录里的删除** | `C:\Windows`、`Program Files`、`ProgramData`、`$Recycle.Bin`、`Recovery` 等。**所有档位、任何模式（含开发者模式）都硬拦。** |
| **带通配符的删除 / 写入** | `Remove-Item *.log` 这类。命中范围在动手前没法逐项核对。**只读操作不受限**，`Get-ChildItem *.txt` 照常。 |
| **改插件自己的配置** | 两样都拦：**配置项的值**（开发者模式、档位、开关、免审窗口）只能由你在设置页或斜杠命令里改；**配置文件本身**（profile 的 `cordis.patch.yml`、本插件的 `package.json`）模型写入会被拦。**读不受限**，它照样能看。 |

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

模型会收到一段提示词，要求它：

1. **说明**——讲清要动的是什么、有什么用、删掉之后会怎样；确实没影响就直说「可以放心清理」。
2. **请你放行**——你会在输入框里执行 `/guard-gettoken`，拿到一串 16 位 token，把这串打给它。
3. **带着 token 重发**——在命令末尾加注释即可：`Remove-Item 'D:\work\old.log' # fg:<那串 token>`。注释不影响执行。
4. 手上还有别的活可以先干完，最后统一汇报，不用一条一条卡着问。

**为什么 token 靠得住**：斜杠命令的输出只进日志，模型上下文里看不到——你执行 `/guard-gettoken` 拿到的东西，它没法自己生成、也没法偷看。

### AI 自己写的临时文件：免审

模型干活会造一堆一次性的东西（探测脚本、截图、日志）。删这些还要问一次纯属互相折磨。

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

- 换个写法的删除看不见：`[System.IO.File]::Delete()`、`fs.rmSync`、`robocopy /MIR` 覆盖。
- `write` / `edit` 工具和 `run_code` 根本不走 shell，不在管辖范围。
- 状态目录的锁靠「看不见」而不是权限——模型换个不把路径写出来的写法（运行时拼字符串、`node -e` 里现拼）就能绕过。

能做的是把门槛抬高，让你有时间踩刹车；真正物理隔离得靠操作系统 ACL。

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
commands: /guard-low /guard-default /guard-high /guard-readonly /guard-temp /guard-gettoken /guard-dev
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
| `devMode` | boolean | `false` | 开发者模式：放行普通删改、`state/` 目录、插件自己的配置文件，只记日志。**盘根和系统目录仍然硬拦** |
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
| `/guard-gettoken` | 取出当前待放行批次的 token（**这是给用户的，模型拿不到输出**） |
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
enabled=false → 放行
devMode=true  → 只放行普通操作，仍先查盘根/系统目录
state/ 或配置文件 → 拦死（写入类工具才查配置文件，读放行）
非 shell 工具   → 记账后放行（write/edit 不在管辖范围）
抽通配符        → 拦死
盘根（仅删除）  → 拦死
protectedHit    → 系统目录
  ├ high + 系统目录 → 拦死
  └ 系统目录删除    → 所有档位拦死
readonly 档      → 只读白名单以外全拦
low 档           → 删除放行
high 档          → 删除和写入都拦
其余             → token 校验 → 拦一次并发 token
```

**token**：16 位，字母表去掉 `I O 0 1` 避免抄错；存在 `state/tokens.json`，同一批目标复用同一个 token，用掉即删。识别正则 `#\s*fg[:\-]([A-Za-z0-9]{16})\b`，匹配后从命令里剥掉再解析路径，避免 token 被当成文件名。

**路径归一化**：全小写、反斜杠转正斜杠、去尾斜杠，盘根用 `/^[a-z]:\\$/` 精确判定（不能用 `startsWith('c:\\')`，那会把整块盘锁死）。

**抽不出路径的命令**（`git clean -fdx`、`robocopy /MIR`）按命令原文签名 `cmd:<kind>|<归一化命令>` 绑 token，不给「重发即放行」的退路。

**旁路台账**：只记路径不碰内容。`write`/`edit` 从 `file_path`/`filePath`/`path`/`target`/`filename` 取；shell 命令从 `extractPaths()` 取。目录不收。

**状态目录保护**：路径匹配三层——绝对路径整串、`dsh-fileguard/state` 片段（挡未归一化的相对路径）、`glob` 的 `pattern`。

**配置文件保护**（`touchesConfigFile()`）：只对写入类调用生效（shell 工具，或 `write` / `edit` / `str_replace_editor` / `apply_patch` / `multi_edit`），读放行。命中条件——命令或目标路径里出现 `cordis.patch.yml`；或同时出现 `package.json` 与 `dsh-fileguard`（不能拦所有 `package.json`，那样正常开发没法干活）。

**配置写入**：命令 handler 必须同步返回，而 `configEditor.edit` 是 async，所以 fire-and-forget，改完由 loader 重载插件生效（通常一两秒）。

**前端**：`lib/client.js` 走 ModuleLoader 包装，`require('react')` 外部化（宿主单例，打进 bundle 会双 React 崩 slots），通过 `ctx.slots.inject('settings.section', ...)` 注册 `id: 'dsh-fileguard'` / `order: 45` / `label: '文件守卫'`，读写走 `configForms.get('dsh-fileguard')` 拿到的 scope。

## 许可

MIT，见 [LICENSE](./LICENSE)。
