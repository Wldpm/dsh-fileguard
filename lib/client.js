// dsh-fileguard 的设置页（客户端半）。
// 格式照 meow-memory：__ModuleLoader__ 单包裹 + react 走宿主单例（external）。
// 不加进来也能用，只是没有设置项、只能靠 /guard-* 命令改。
window.__ModuleLoader__.load({
  id: 'dsh-fileguard',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const el = React.createElement;

    const NS = 'dsh-fileguard';

    const POLICIES = [
      { key: 'low', label: '低守卫', hint: '只硬拦盘根和系统目录的删除，普通删除直接放行' },
      { key: 'default', label: '默认', hint: '删除命令拦下来，要模型说明清楚、你给它 token 才放行' },
      { key: 'high', label: '高拦截', hint: '删除和修改命令都拦；read / write / edit 这些工具不受影响' },
      { key: 'readonly', label: '纯白名单', hint: '只放行只读命令，其余一律拦死' },
    ];

    const S = {
      wrap: { padding: '4px 0 8px' },
      row: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '9px 0', borderTop: '1px solid var(--dsh-border, rgba(128,128,128,.18))' },
      rowFirst: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '9px 0' },
      label: { width: '150px', flex: '0 0 150px', fontSize: '13px', paddingTop: '2px' },
      body: { flex: '1 1 auto', minWidth: '0' },
      hint: { fontSize: '12px', opacity: 0.6, marginTop: '4px', lineHeight: 1.5 },
      input: { width: '88px', fontSize: '13px', padding: '3px 6px', borderRadius: '5px', border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit' },
      btn: { fontSize: '12px', padding: '3px 10px', borderRadius: '5px', border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      pill: (on) => ({
        fontSize: '12px', padding: '3px 10px', marginRight: '6px', marginBottom: '6px', borderRadius: '999px',
        border: '1px solid ' + (on ? 'var(--dsh-accent, #4a8cff)' : 'var(--dsh-border, rgba(128,128,128,.35))'),
        background: on ? 'var(--dsh-accent-weak, rgba(74,140,255,.14))' : 'transparent',
        color: 'inherit', cursor: 'pointer',
      }),
      warn: { fontSize: '12px', lineHeight: 1.6, marginTop: '6px', padding: '7px 9px', borderRadius: '6px', background: 'rgba(220,60,60,.12)', border: '1px solid rgba(220,60,60,.35)' },
      err: { fontSize: '12px', color: '#d64545', marginTop: '6px' },
      ok: { fontSize: '12px', color: '#2f9e5f', marginTop: '6px' },
    };

    function softService(ctx, name) {
      try {
        return ctx?.get?.(name);
      } catch {
        return undefined;
      }
    }

    // 外层只做一件事：确认宿主给的 scope 具备我们需要的三个方法。
    // 缺任何一个就渲染一句说明而不是抛异常——设置页别被我们搞崩。
    // hooks 全在 SectionLive 里，这里提前 return 不违反 hooks 规则。
    function Section(props) {
      const scope = props && props.scope;
      const usable =
        scope &&
        typeof scope.subscribe === 'function' &&
        typeof scope.getSnapshot === 'function' &&
        typeof scope.set === 'function';
      if (!usable) {
        return el('div', { style: S.wrap },
          el('div', { style: { fontSize: '13px', fontWeight: 600 } }, '文件守卫'),
          el('div', { style: S.hint }, '这个版本没提供可写的设置入口，暂时改不了配置。可以用聊天框里的 /guard-low、/guard-default、/guard-high、/guard-readonly、/guard-temp 来调。'),
        );
      }
      return el(SectionLive, props);
    }

    function SectionLive(props) {
      const scope = props.scope;
      const subscribe = React.useCallback((cb) => scope.subscribe(cb), [scope]);
      const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope]);
      const snap = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      const value = (snap && snap.value) || {};
      const writable = !snap || snap.writable !== false;

      const [err, setErr] = React.useState(null);
      const [okMsg, setOkMsg] = React.useState('');
      const [hours, setHours] = React.useState(null);

      const commit = async (key, next) => {
        setErr(null);
        setOkMsg('');
        try {
          const landed = await scope.set(key, next);
          if (landed === false) setErr('写入没落地（宿主拒绝了这次修改）');
          else setOkMsg('已保存');
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      };

      const enabled = value.enabled !== false;
      const policy = typeof value.policy === 'string' ? value.policy : 'default';
      const tempHours = typeof value.tempHours === 'number' ? value.tempHours : 8;
      const devMode = value.devMode === true;
      const shownHours = hours === null ? String(tempHours) : hours;

      const commitHours = () => {
        const n = Number(shownHours);
        if (!Number.isFinite(n) || n < 0 || n > 720) {
          setErr('小时数要在 0 - 720 之间（0 = 关掉这个机制）');
          return;
        }
        setHours(null);
        void commit('tempHours', n);
      };

      const rows = [];

      rows.push(
        el('div', { key: 'enabled', style: S.rowFirst },
          el('div', { style: S.label }, '守卫开关'),
          el('div', { style: S.body },
            el('label', { style: { fontSize: '13px', cursor: writable ? 'pointer' : 'default' } },
              el('input', {
                type: 'checkbox',
                checked: enabled,
                disabled: !writable,
                onChange: (e) => void commit('enabled', e.target.checked),
              }),
              ' 启用文件守卫',
            ),
            el('div', { style: S.hint }, '关掉之后所有删除、写入、修改都不再拦——等于没装这个插件。'),
          ),
        ),
      );

      rows.push(
        el('div', { key: 'policy', style: S.row },
          el('div', { style: S.label }, '守卫强度'),
          el('div', { style: S.body },
            el('div', null, POLICIES.map((p) =>
              el('button', {
                key: p.key,
                type: 'button',
                disabled: !writable,
                style: S.pill(p.key === policy),
                onClick: () => void commit('policy', p.key),
              }, p.label),
            )),
            el('div', { style: S.hint },
              (POLICIES.find((p) => p.key === policy) || {}).hint || '',
              '　盘根和系统目录的删除在所有档位下都是硬拦，删不掉的。',
            ),
          ),
        ),
      );

      rows.push(
        el('div', { key: 'temp', style: S.row },
          el('div', { style: S.label }, '临时文件放行'),
          el('div', { style: S.body },
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              el('input', {
                type: 'number',
                min: 0,
                max: 720,
                step: 1,
                value: shownHours,
                disabled: !writable,
                style: S.input,
                onChange: (e) => setHours(e.target.value),
                onBlur: commitHours,
                onKeyDown: (e) => { if (e.key === 'Enter') commitHours(); },
              }),
              el('span', { style: { fontSize: '13px' } }, '小时'),
            ),
            el('div', { style: S.hint }, 'AI 自己写出来的临时文件，在这个时间窗口内删掉不用再问你。0 = 关掉这个机制。'),
          ),
        ),
      );

      rows.push(
        el('div', { key: 'hint', style: S.row },
          el('div', { style: S.label }, '提示词初始化'),
          el('div', { style: S.body },
            el('button', {
              type: 'button',
              disabled: !writable,
              style: S.btn,
              onClick: () => void commit('hintResetAt', Date.now()),
            }, '重置一次性提示'),
            el('div', { style: S.hint }, '有些说明（比如当前档位）只在第一次拦截时出现，之后就省掉了。点这里让它们下次重新出现一遍。'),
          ),
        ),
      );

      rows.push(
        el('div', { key: 'dev', style: S.row },
          el('div', { style: S.label }, '开发者模式'),
          el('div', { style: S.body },
            el('label', { style: { fontSize: '13px', cursor: writable ? 'pointer' : 'default' } },
              el('input', {
                type: 'checkbox',
                checked: devMode,
                disabled: !writable,
                onChange: (e) => void commit('devMode', e.target.checked),
              }),
              ' 放行 state/ 与自己的配置（普通删改也放行）',
            ),
            devMode
              ? el('div', { style: S.warn }, '⚠️ 开发者模式开着：普通删改、state/ 目录、守卫自己的配置都放行了，只记日志。**盘根和系统目录依然拦着**。调试完记得关掉。')
              : el('div', { style: S.hint }, '调试用：放行 state/、配置文件和普通删改，方便查问题。盘根和系统目录照样硬拦。平时别开。'),
          ),
        ),
      );

      return el('div', { style: S.wrap },
        el('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '2px' } }, '文件守卫'),
        el('div', { style: S.hint }, '删除和修改前的中文确认层。真正的硬限制只有两条：盘根和系统目录的删除。'),
        rows,
        err ? el('div', { style: S.err }, err) : null,
        okMsg ? el('div', { style: S.ok }, okMsg) : null,
        !writable ? el('div', { style: S.hint }, '当前是只读镜像，改不了配置。') : null,
      );
    }

    function apply(ctx) {
      const slots = ctx?.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;

      const settingsScope = softService(ctx, 'settingsScope');
      const configForms = softService(ctx, 'configForms');

      const bindScope = () => {
        // 两个入口都试：新版有 settingsScope，老版只有 configForms。
        // 拿到之后还要确认这三个方法在——不确认的话 Section 一渲染就炸。
        const candidates = [];
        if (settingsScope && typeof settingsScope.bind === 'function') {
          try {
            candidates.push(settingsScope.bind({ namespace: NS }));
          } catch {
            // bind 失败就换下一个入口
          }
        }
        if (configForms && typeof configForms.get === 'function') {
          try {
            candidates.push(configForms.get(NS));
          } catch {
            // get 失败同上
          }
        }
        for (const s of candidates) {
          if (
            s &&
            typeof s.subscribe === 'function' &&
            typeof s.getSnapshot === 'function' &&
            typeof s.set === 'function'
          ) {
            return s;
          }
        }
        return undefined;
      };

      let dispose = null;
      let haveScope = false;
      const register = () => {
        const scope = bindScope();
        if (scope !== undefined) haveScope = true;
        // scope 拿不到也照样注册：让用户至少看到「文件守卫」这一项和一句说明，
        // 而不是整个栏目凭空消失（那样他只会觉得插件没装上）。
        try {
          dispose?.();
        } catch {
          // 旧注册已经没了，忽略
        }
        try {
          dispose = slots.register(
            {
              name: 'settings.section',
              id: NS,
              order: 45,
              label: () => '文件守卫',
              inject: () => ({ scope }),
            },
            Section,
          );
        } catch {
          dispose = null;
        }
      };

      const undoInject = slots.inject('settings.section', register);

      // 有些宿主里 slots 就绪了但 settingsScope/configForms 还在路上，隔一会儿再试几次。
      // 一旦真的拿到可写的 scope 就停——否则每 500ms 重注册一次，白白闪。
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (haveScope || tries > 40) {
          clearInterval(timer);
          return;
        }
        register();
      }, 500);

      ctx.effect?.(() => () => {
        clearInterval(timer);
        try {
          undoInject?.();
        } catch {
          // 卸载顺序不一定随我们，忽略
        }
        try {
          dispose?.();
        } catch {
          // 同上
        }
      });
    }

    module.exports.apply = apply;
    // 必须把用到的服务全声明出来：cordis 的 inject 是「服务可用之前先声明依赖」，
    // 没声明过的服务 ctx.get() 拿不到。设置页的可写 scope 挂在 remote.settings 这条线上
    // （settingsScope / configForms 都是它带出来的），只写 'slots' 会让 bindScope()
    // 永远返回 undefined —— 现象就是栏目出来了、里面只有一句「没提供可写的设置入口」。
    module.exports.inject = ['slots', 'sessions', 'remote.settings'];
    return module.exports;
  },
});
