# dsh-fileguard

给 **DeepSeek Harness** 用的文件守卫插件：在模型动手删东西之前先拦一道，逼它停下来把话说清楚；模型自己生成的临时文件则按台账免审，不打扰你。

## 它解决什么问题

DSH 的沙箱权限分几档。开 `workspace-write` 之后，真正拦得住危险操作的是系统弹的提权确认框——但那个框里全是英文路径和一堆 `$ % #`符号，扫一眼根本判断不了点下去会发生什么，手一快就同意了。

这层壳的作用**不是技术性拦截**，而是**在那道弹窗之前先让Agent给一份能看懂的说明**：要动什么、这东西干什么用、删了会怎样。模型拿不到你的点头就不能自己往下走。

## 先说清楚：这是软约束，不是安全边界

**这个插件挡不住一个执意要删东西的模型。**

它的核心机制只有一条：**在命令执行前拦一下，然后给模型返回一段提示词**，要求它停下来向你说明。约束力来自提示词，不是来自权限。

- 「原样重发即放行」分不清「用户真点头了」和「模型自己想删」——插件没有渠道验证。
- 换个写法的删除它看不见：`[System.IO.File]::Delete()`、`fs.rmSync`、`robocopy /MIR` 覆盖。
- `write` / `edit` 工具和 `run_code`（PTC）根本不走 shell，不在管辖范围内。

**真正重发多少次都不放行的只有盘根**。系统目录在 `high` 档下也是硬拦，`low` / `default` 档则会留一条「说明 + 点头」的路——因为确实有人需要改系统目录里的东西，全锁死等于逼人关插件。

一句话：它是一道减速带，让你有时间踩刹车，不是一堵墙。

## 四档策略

| 档位 | 斜杠命令 | 删除 | 写入 / 改盘 | 盘根 | 系统目录：删 | 系统目录：改 |
|---|---|---|---|---|---|---|
| 纯白名单 | `/guard-readonly` | 拦死 | 拦死 | 拦死 | 拦死 | 拦死 |
| 高拦截 | `/guard-high` | 拦一次 | 拦一次 | 拦死 | 拦死 | 拦死 |
| 默认 | `/guard-default` | 拦一次 | 放行 | 拦死 | 拦死 | 拦一次 |
| 低守卫 | `/guard-low` | 放行 | 放行 | 拦死 | 拦死 | 拦一次 |

- **拦死** = 重发多少次都不放行，提示里明确写「不要再试」。
- **拦一次** = 插件挡下并发一串**一次性 token**；你把 token 打给模型，它带着重发才放行。token 只覆盖这次拦下的那批目标，用掉即废。
- **放行** = 直接执行，模型不会看到任何提示。

切档**立刻生效**，不用重启 DSH，在聊天框直接打 `/guard-xxx` 就行。

**档位存在 `state/policy.json`，但守卫对整个 `state/` 目录的访问一律拦死（读取也算）。** 模型手上的权限能读能写任何文件，唯一的办法是让它看不见那个目录——连内容都读不到，就无从改起。重启 DSH 后档位还在。

## AI 自己写的临时文件：免审

模型干活时会造一堆一次性的东西——探测脚本、截图、日志、中间产物。删这些还要停下来问一次，纯属互相折磨。

所以插件维护一份**旁路台账**，存在 `state/ai-created.json`（这个目录同样被守卫锁死）：

- 模型用 `write` / `edit` 等非 shell 工具写文件时，把路径记进去。
- 模型跑 `Set-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Move-Item` 这类写盘命令时，把命令里出现的路径记进去。
- 之后删这些路径，**`low` / `default` 档下直接放行**，不再拦。

**只认台账上登记过的路径**。你自己新建的文件不在账上，照旧要走确认——这是整个机制能成立的前提。也正因如此它不碰文件内容、也不看 `birthtime`（那个值被原子写一覆盖就变，而 `dsh-atomic-write` 就在 DSH 的依赖里）。

四条限制：

1. **目录不放行**。刚 clone 的仓库、刚解压的包同样会被记进台账，但删错的代价大得多，一律走确认。
2. **通配符不放行**，跟其他规则一致。
3. **`high` / `readonly` 档不生效**——那两档的态度就是「别自己判断」。
4. **窗口有限**，默认 8 小时，过期的记录不再免审。台账最多留 5000 条，超了按时间淘汰最旧的。

窗口用 `/guard-temp` 调：

| 命令 | 效果 |
|---|---|
| `/guard-temp` | 循环切换：1 → 4 → 8 → 24 → 72 → 关 |
| `/guard-temp 12` | 直接设成 12 小时 |
| `/guard-temp 0` | 关掉这个机制，临时文件也走确认 |

跟档位一起存在 `state/policy.json`，**改完立刻生效**，重启也还在。

## 状态目录：模型读不到，也改不了

插件把自己需要记住的东西放在插件目录下的 `state/`：

| 文件 | 存什么 |
|---|---|
| `policy.json` | 当前档位、临时文件免审窗口 |
| `tokens.json` | 待放行的 token，每条绑着它授权的那批路径 |
| `ai-created.json` | 旁路台账：AI 自己建过哪些文件 |

**守卫对这个目录的任何访问都拦死，读取也算。** 不管哪一档、不管用哪个工具——`cat state/policy.json`、`read` 工具、`glob` 扫描，全部拒绝。理由很简单：这套守卫的全部权威都在这几个文件里，模型能看它一眼就等于没有守卫。读不到，也就没法伪造台账、没法把档位改成 `low`、没法把 token 抄走。

档位、窗口、token 都在重启后保留。

**你自己怎么改**：守卫拦的是模型，不拦你。可以直接用编辑器打开 `state/policy.json` 改，也可以用 `/guard-*` 命令——后者更省事，而且是唯一「立刻生效」的路径。

**这条不是绝对安全**。模型手上终究是同一个账户的权限，它要是换个不把路径写出来的写法（运行时拼字符串、`node -e` 里现拼），守卫就看不见路径了。所以这里做的是**把门槛抬高**，不是物理隔离；真要做到读都读不到，得靠操作系统的 ACL，那已经超出插件能做的范围。

## 永远不放行的

不管当前是哪一档：

1. **带 `*` 的删除 / 写入命令**
   通配符命中的范围在动手之前没法逐项核对——你不知道会命中哪些文件，用户也看不清会丢什么。正确做法是先列出实际命中的清单，让用户挑，再对具体路径逐个点名操作。
   **只读操作不受此限**：`Get-ChildItem *.txt`、`Select-String pattern *.log` 这类照常放行。

2. **任意盘的根目录**（`C:\`、`D:\`、`E:\`、插上来的 U 盘盘根……）
   盘根下面就是整块盘的全部内容，删它等于清空这块盘。所有档位、重发多少次都不放行。

## 拦一次之后：模型会看到什么

命中「拦一次」的命令时，插件会把下面这段话返回给模型（节选）：

```
【dsh-fileguard 拦截】

这条命令被守卫插件拦下了——不是沙箱拒绝，不是权限不足，也不是命令写错了。
插件只是在等你说清楚。这次什么都没删。

命令：Remove-Item 'D:\work\old.log'
这次要确认的目标：D:\work\old.log

接下来这样做：

1) 说明。讲清楚这是什么东西、有什么用、删掉之后会怎样；
   确实没影响就直说「可以放心清理」。
2) 请用户放行。告诉他：在输入框执行 /guard-gettoken 拿到一串 token，然后把这串打给你。
   放行的凭据只有用户能拿到，你没法自己生成——这一步不能跳。
3) 拿到 token 后把命令原样重发，末尾加注释（不影响执行）：
   Remove-Item ... # fg:<那串 token>
   token 只放行这一次拦下的这批目标，用掉即废。
4) 手上还有跟这条无关、也不依赖它结果的操作，可以先去做——
   别为了一条被拦的命令把整个任务卡住；记住有哪几条被拦了。

当前档位：默认（default）— 删除命令拦一次，要模型说明清楚你点头后再放行
换档：/guard-low · /guard-default · /guard-high · /guard-readonly（风险低 → 高）
```

> 最后那两行档位脚注**只在本次会话第一次拦截时出现**，之后不再重复——省 token，也免得每拦一次都刷一遍同样的说明。

### token 是怎么来的

用户执行 `/guard-gettoken`，聊天框里会打印：

```
>_ guard-gettoken 已获取本次守卫token:7KQ2MXN4PWTB9RHJ
```

**这行输出不进模型上下文**（斜杠命令是本地命令，不产生对话轮次）——所以模型拿不到，必须由用户亲手递过去。这是整个机制唯一的凭据来源。

- 16 位，够长，靠猜不现实。
- **只绑那批目标**：token 覆盖的是「这次被拦下的这些路径」，命令里多出没授权的东西会被挡下。
- **用掉即废**：成功执行一次就作废。
- **不过期**：你什么时候想起来再给它都行。
- **落盘但锁死**：存在 `state/tokens.json`，那个目录守卫连读都不给，所以放盘上不怕模型摸走。
- **重启还在**：DSH 重启后你手上那串还没作废，不用重新要一次。
- **同一批目标重新被拦，token 不会换**：不然你手上刚复制的那串立刻作废，来回拉锯永远过不去。

另外几条：

- **多步操作不会卡住**：模型可以先做别的，最后统一跟你汇报一次，你一次给它 token、它逐条重发。
- **按目标记，不按命令原文记**：同一条删除换个写法（加 `-Force`、拆成两条、几条合并成一条）都能用同一个 token 过。
- **中途加目标要重新要 token**：命令里多出没授权的东西会被挡下并列出多出来的部分——故意这么设计，省得模型顺手把范围扩大。
- **抽不出路径的命令按命令原文签名绑**：`git clean -fdx`、`robocopy /MIR` 这类命令里没有具体路径，token 绑的是归一化后的整条命令。参数换个顺序（`-xdf`）签名就变了，会被再拦一次——宁可多拦一次，也不能让它一句话把没提交的东西全清掉。

## 安装

插件是标准的 DSH bundle，仓库根目录就是插件根目录。

**能不能用 `dsh plugin add` 装？** 能：

```powershell
# 从本地目录装（最稳）
dsh plugin --profile desktop add <仓库绝对路径>

# 从 GitHub 装：Windows 上很可能撞 SSL 证书错误，见下面「依赖坑」
dsh plugin --profile desktop add github:<用户名>/dsh-fileguard
```

**能不能从插件市场装？** 暂时不能。市场里的条目要求是已发布到 npm 并登记进 market index 的包，这个插件目前只是个本地 bundle。

**方式一：链接安装（开发用）**

```powershell
# 1. 把仓库放到任意位置，比如 ~/.dsh/plugins/dsh-fileguard
# 2. 在目标 profile 的 package.json 里加依赖与 bundle
#    "dependencies": { "dsh-fileguard": "link:<仓库绝对路径>" }
#    "dsh": { "profile": { "bundles": [ ..., "dsh-fileguard" ] } }
# 3. 在 profile 目录跑 pnpm install，然后重启 DSH
```

**方式二：手动**

1. 把仓库内容复制到 `<DSH_HOME>/plugins/dsh-fileguard/`。
2. 在 `<DSH_HOME>/profiles/<profile>/package.json` 里按上面方式一加 `link:` 依赖和 bundle 条目。
3. `pnpm install`，重启 DSH。

### 依赖坑（必读）

插件只有一个运行时依赖：`@deepseek-ai/schemastery`，它由 DSH 自带、**不需要单独安装**。

但如果你是**用 `link:` 方式挂在 profile 目录之外**，Node 解析模块时是按插件的**真实路径**往上找 `node_modules` 的，而在那里找不到 `schemastery`，插件会在加载阶段直接报：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

这时在插件目录里建一个指向 profile 的 junction 即可：

```powershell
New-Item -ItemType Junction `
  -Path 'C:\Users\<你>\.dsh\plugins\dsh-fileguard\node_modules\@deepseek-ai' `
  -Target 'C:\Users\<你>\.dsh\profiles\<profile>\node_modules\@deepseek-ai'
```

用 `dsh plugin add` 或把插件装进 profile 目录内部则不会有这个问题。

## 让 Agent 帮你装

安装要改 profile 的 `package.json`、处理依赖解析路径、跑 `pnpm install`、重启后验日志——手敲容易漏一步。最省事的办法是把下面这段直接丢给你的 Agent（路径换成你自己的）：

> 帮我安装 `dsh-fileguard` 插件，仓库路径 `<仓库绝对路径>`。按顺序做：
>
> 1. 在 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dependencies` 里加 `"dsh-fileguard": "link:<仓库绝对路径>"`，同时在 `dsh.profile.bundles` 数组末尾加 `"dsh-fileguard"`。
> 2. 插件在 profile 目录之外时，不额外处理会在加载阶段报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`——需要在 `<仓库>/node_modules/@deepseek-ai` 建一个 junction 指向 `<DSH_HOME>/profiles/<profile>/node_modules/@deepseek-ai`（原因见上一节「依赖坑」）。
> 3. 在 `<DSH_HOME>/profiles/<profile>` 目录执行 `pnpm install`。
> 4. 重启 DSH。bundle 变更不热更新，关窗口不等于退出进程，要确认主进程真的退出了。
> 5. 重启后检查 `<系统临时目录>/dsh-fileguard.log`，必须同时出现两行才算装好：`apply; ... policy=default` 和 `commands: /guard-low /guard-default /guard-high /guard-readonly`。只有前者说明插件挂了但命令没注册上，两条都没有说明没加载。
> 6. 安装完成后，你需要告知用户该插件新增了`/guard`类别的命令及其用途

装好后让用户在聊天框打 `/guard-high` 试一下，能切档就说明整条链路通了。

## 配置项

在 profile 的 `cordis.patch.yml` 里给 `dsh-fileguard` 条目加 `config:` 段即可（改完要重启）。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | bool | `true` | 总开关。关掉后所有命令直接放行，对模型完全无感 |
| `policy` | string | `default` | 初始档位。`/guard-*` 命令会把新值写进 `state/policy.json`，那里优先于本项 |
| `guardWrites` | bool | `true` | 保留字段，当前不参与判定（写入是否拦截由 `policy` 决定） |
| `allowSecondAttempt` | bool | `true` | 保留字段，当前不参与判定（放行凭据现在是 token） |
| `protectedDirs` | string[] | 系统目录 | 额外的受保护目录。留空则用内置名单 |
| `readOnlyMode` | bool | `false` | 纯白名单模式，等价于 `policy: readonly` |
| `tempHours` | number | `8` | AI 临时文件免审窗口（小时），0 = 关掉。`/guard-temp` 会写进 `state/policy.json`，那里优先于本项 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_FILEGUARD_LOG` | 日志路径，默认 `<系统临时目录>/dsh-fileguard.log` |

> 状态实际存在 `state/` 下（见上文「状态目录」），不走环境变量配置。`DSH_FILEGUARD_STATE` 只给测试用，会把状态目录整体挪到别处。

日志每一行是一次判定：`DENY(glob,delete)`、`DENY(protected:root:C:\,delete)`、`DENY(protected:sys:C:\Windows,delete)`、`ALLOW(ai-created:2,8h,delete)`、`CREATED +1 by=write`、`DENY(first,delete,token-issued)`、`ALLOW(token,delete,3)`、`DENY(token-invalid,delete)`、`DENY(token-scope:2,delete)`、`POLICY=high`、`TEMP_HOURS=4`。

## 已知边界

**这是减速带，不是安全边界。** 下面这些绕得过去，别把它当成最后一道防线：

- 换写法的删除：`[System.IO.File]::Delete()`、`fs.rmSync`、`robocopy /MIR`、`Move-Item -Force` 覆盖
- `run_code` / PTC 里执行的代码
- `write` / `edit` 工具本身（它们不走 shell）

另外三条设计上的折中：

- **token 挡住了「模型自己放自己」，但挡不住换写法**。上面那三条绕过方式仍然有效——token 只管「模型有没有拿到用户许可」，管不了「它换了个删除方式」。
- **`?` 没有当成通配符拦**。它确实是 PowerShell 的通配符，但在正常代码里太常见（三元的 `a ? b : c`、`Where-Object` 的别名 `?`、正则里的 `?`），一律拦会疯狂误伤；而单独用 `?` 删文件几乎没人这么写，危害也小得多。
- **状态目录的锁靠「看不见」，不是靠权限**。`state/` 被守卫拦死（读取也算），但模型要是换个不把路径写出来的写法（运行时拼字符串、`node -e` 里现拼），守卫就看不见路径。真隔离得靠操作系统的 ACL，超出插件能做的范围。

## 许可

MIT
