/**
 * 创作展示台 — client 半区。
 *
 * 向左侧菜单（sidebar.panellist）注册“创作展示台”入口，并向 main 面板槽
 * 注册同 key 的面板组件（iframe 装载 host 端 /studio 工作台页面）。
 *
 * 注册使用 dsh 的 __ModuleLoader__ 契约（与官方 plugin-manager / agnes-media 一致）：
 * 必须通过 window.__ModuleLoader__.load 显式注册，且 React 由 require('react') 取得，
 * 不能用裸 ESM `export`。
 */

window.__ModuleLoader__.load({
  id: '@local/creative-studio',
  factory(require) {
    const React = require('react');

    /** 面板 id：main 槽的 key 与菜单项的 id 保持一致。 */
    const PANEL_ID = 'creative-studio';

    /**
     * 菜单图标：随选中态着色。
     * @param {{size?: number, active?: boolean}} props
     */
    function StudioGlyph({ size, active }) {
      const color = active === true
        ? 'var(--dsw-alias-state-business-primary, #6d8bff)'
        : 'currentColor';
      return React.createElement('svg', {
        viewBox: '0 0 48 48',
        width: size ?? 18,
        height: size ?? 18,
        'aria-hidden': 'true',
      },
      React.createElement('rect', { x: 5, y: 5, width: 38, height: 38, rx: 10, fill: 'none', stroke: color, strokeWidth: 3 }),
      React.createElement('path', { d: 'M16 27c5.5-1.8 7.3-5.5 8-11 .7 5.5 2.5 9.2 8 11-5.5 1.8-7.3 5.5-8 11-.7-5.5-2.5-9.2-8-11z', fill: color }),
      React.createElement('circle', { cx: 25, cy: 12.5, r: 2.4, fill: color }),
      React.createElement('circle', { cx: 15.5, cy: 17.5, r: 1.7, fill: color }),
      React.createElement('circle', { cx: 34.5, cy: 17.5, r: 1.7, fill: color }));
    }

    /**
     * 内联 SVG 旋转指示器（不依赖 CSS keyframes）。
     */
    function Spinner() {
      return React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        React.createElement('circle', {
          cx: 12, cy: 12, r: 9, fill: 'none', stroke: '#6d8bff',
          strokeWidth: 3, strokeDasharray: '42 18', strokeLinecap: 'round',
        }, React.createElement('animateTransform', {
          attributeName: 'transform', type: 'rotate',
          from: '0 12 12', to: '360 12 12', dur: '0.9s', repeatCount: 'indefinite',
        })));
    }

    /**
     * 工作台面板：iframe 装载 /studio（同源，带 GUI 会话凭据）。
     * iframe 首帧绘制前显示加载指示，改善慢链路下的观感。
     */
    function StudioPanel() {
      const state = React.useState(false);
      const isLoaded = state[0];
      const setLoaded = state[1];
      return React.createElement('div', {
        style: { position: 'relative', width: '100%', height: '100%', background: '#0d1117' },
      },
      React.createElement('iframe', {
        src: '/studio',
        title: '创作展示台',
        onLoad: function () { setLoaded(true); },
        style: {
          width: '100%',
          height: '100%',
          border: 'none',
          background: '#0d1117',
          display: 'block',
        },
        allow: 'clipboard-write',
      }),
      isLoaded ? null : React.createElement('div', {
        style: {
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 10, color: '#8b96b3', fontSize: 13,
          background: '#0d1117', pointerEvents: 'none',
        },
      }, React.createElement(Spinner), React.createElement('span', null, '正在加载创作展示台…')));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, StudioPanel));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 50,
          label: '创作展示台',
        }, StudioGlyph));
      },
    };
  },
});
