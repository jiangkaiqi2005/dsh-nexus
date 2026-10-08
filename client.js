window.__ModuleLoader__.load({
  id: 'dsh-nexus',
  factory(require) {
    const h = require('react').createElement
    return {
      inject: ['slots', 'uiWorkspace', 'locale'],
      apply(ctx) {
        ctx.locale.register('nexus', 'en', { open: 'Open Nexus' })
        ctx.locale.register('nexus', 'zh', { open: '打开 Nexus' })
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'nexus', order: -10, locale: 'nexus',
          inject: () => ({ open: () => ctx.uiWorkspace.openSession('nexus-supervisor') }),
        }, ({ open, t, wide }) => h('button', {
          type: 'button', title: t('open'), 'aria-label': t('open'), onClick: open,
          style: { color: 'inherit', background: 'transparent', border: 0, cursor: 'pointer', padding: 8 },
        }, wide ? 'Nexus' : 'N')))
      },
    }
  },
})
